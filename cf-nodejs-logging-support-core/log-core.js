var util = require('util');
var os = require('os');
var uuid = require('uuid/v4');
var jwt = require('jsonwebtoken');

const envDynLogHeader = "DYN_LOG_HEADER";
const envDynLogKey = "DYN_LOG_LEVEL_KEY";
const dynLogLevelDefaultHeader = "SAP-LOG-LEVEL";

const reductedPlaceholder = "redacted";

const nsPerSec = 1e9;
const logType = "log";
const loggingLevels = {
    'error': 0,
    'warn': 1,
    'info': 2,
    'verbose': 3,
    'debug': 4,
    'silly': 5
};

var fixedValues = {};
var initDummy = "{}";
var logLevelInt = 2;
var pattern = null;
var stdout = process.stdout;
var patternDivider = /((?:\{\{)([^\}\{]+)(?:\}\}))/g;
var uuidCheck = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/;

var preLogConfig = [];
var postLogConfig = [];

var dynLogLevelHeader = dynLogLevelDefaultHeader;

// Initializes the core logger, including setup of environment var defined settings
var init = function() {
    // Read dyn. log level header name from environment var
    var headerName = process.env[envDynLogHeader];
    if(headerName != null && headerName != "null" && headerName != "") {
        dynLogLevelHeader = headerName;
    } else {
        dynLogLevelHeader = dynLogLevelDefaultHeader;
    }

    // Read dyn log level key from environemt var.
    dynLogLevelKey = process.env[envDynLogKey];
}

var setConfig = function (config) {
    precompileConfig(config);
}

var precompileConfig = function (config) {
    var coreConfig = [];
    preLogConfig = [];
    postLogConfig = [];

    for (var i = 0; i < config.length; i++) {
        var obj = config[i];

        // Check if config field needs a set env var to be enabled. If specified env var does not exist, the resulting log field will be replaced by reductedPlaceholder
        if(obj.envVarSwitch != null) {
            var val = process.env[obj.envVarSwitch];
            var pass = (val == "true" || val ==  "True" || val == "TRUE");
            if(!pass) {
                // Uncomment to enable log field reduction (currently breaking test cases)
                obj.reduce = true;
            }
        }

        if (obj.core) {
            coreConfig.push(obj);
        } else if (obj.source.type == "time") {
            preLogConfig.push(obj);
            postLogConfig.push(obj);
        } else if ((obj.source.parent != null && obj.source.parent == "res")) {
            postLogConfig.push(obj);
        } else {
            preLogConfig.push(obj);
        }
    }

    var logObject = prepareInitDummy(coreConfig);
    initDummy = JSON.stringify(logObject);
}

var getPreLogConfig = function () {
    return preLogConfig;
}

var getPostLogConfig = function () {
    return postLogConfig;
}

var handleConfigDefaults = function (configEntry, logObject, fallbacks) {
    if (configEntry.mandatory && logObject[configEntry.name] == null) {
        if (configEntry.default != null) {
            logObject[configEntry.name] = configEntry.default;
        } else {
            fallbacks[configEntry.name] = configEntry.fallback;
        }
    }
}

// Replace all fields, which are marked to be reduced and do not equal to their default value, empty or "-", to reductedPlaceholder.
var reduceFields = function(config, logObject) {
    for(var i = 0; i < config.length; i++) {
        var configEntry = config[i];

        if(configEntry.reduce) {
            var value = logObject[configEntry.name];
            var defaultValue = configEntry.default != null ? configEntry.default : "-";
            if(value == null || value == "" || value == defaultValue) {
                continue;
            }
            logObject[configEntry.name] = reductedPlaceholder;
        }
    }
}

// Stringify and log given object to console. If a custom pattern is set, the referenced object fields are used to replace the references.
var writeLogToConsole = function (logObject) {
    var output = "";
    if (null != pattern) {
        if (undefined !== logObject && logObject != null) {
            output = "";
            var rest = pattern.split(patternDivider);
            var value;
            //iterates over split custom pattern, where n%3=0 is text outside the marked fields and n%3=2 are the fields to be replaced (inside {{}}), n elem rest.
            for (i = 0; i < (rest.length - 1) / 3; i++) {
                output += rest[i * 3];
                value = logObject[rest[2 + i * 3]];
                if (value != null) {
                    if (typeof value == "string") {
                        output += value;
                    } else {
                        output += JSON.stringify(value);
                    }
                }

            }
            output += rest[rest.length - 1];
        }
    } else {
        output = (undefined !== logObject && validObject(logObject)) ? JSON.stringify(logObject) : '';
    }

    stdout.write(output + os.EOL);
}

// Sets the minimum logging level. Messages with a lower level will not be forwarded. (Levels: error, warn, info, verbose, debug, silly)
var setLoggingLevel = function (level) {
    if (loggingLevels[level] != undefined) {
        logLevelInt = loggingLevels[level];
        return true;
    }
    return false
}
// Gets the minimum logging level. (Levels: error, warn, info, verbose, debug, silly)
var getLoggingLevel = function () {
    for (var key in loggingLevels) {
        if (loggingLevels[key] == logLevelInt) {
            return key;
        }
    }
};

// Initializes an empty log object
var initLog = function () {

    var time = process.hrtime();
    var logObject = JSON.parse(initDummy);

    logObject.written_at = (new Date()).toJSON();
    logObject.written_ts = time[0] * nsPerSec + time[1];

    return logObject;

};

var prepareInitDummy = function (coreConfig) {
    var obj = {};


    var fallbacks = [];
    var selfReferences = [];
    var configEntry;

    for (var i = 0; i < coreConfig.length; i++) {
        configEntry = coreConfig[i];
        switch (configEntry.source.type) {
            case "env":
                obj[configEntry.name] = process.env[configEntry.source.name];
                break;
            case "nested-env":
                obj[configEntry.name] = resolveNestedVariable(process.env, configEntry.source.path);
                break;
            case "static":
                obj[configEntry.name] = configEntry.source.value;
                break;
            case "self":
                selfReferences[configEntry.name] = configEntry.source.name;
                break;
        }
        handleConfigDefaults(configEntry, obj, fallbacks);
    }

    for (var key in fallbacks) {
        obj[key] = fallbacks[key](obj);
    }

    for (var key in selfReferences) {
        obj[key] = obj[selfReferences[key]];
    }

    reduceFields(coreConfig, obj);
    return obj;
};

// Resolves a path to a variable in a structure of objects to its value. Parts of the object hierarchy that are represented as strings will be parsed.
var resolveNestedVariable = function (root, path) {

    // return, if path is empty.
    if(path == null || path.length == 0) {
        return null;
    }

    var rootObj;

    // if root is a string => parse it to an object. Otherwise => use it directly as object.
    if (typeof root === 'string') {
        rootObj = JSON.parse(root);
    } else if (typeof root === 'object') {
        rootObj = root;
    } else {
        return null;
    }

    // get value from root object
    var value = rootObj[path[0]];

    // cut first entry of the object path
    path.shift();

    // if the path is not empty, recursively resolve the remaining waypoints.
    if(path.length >= 1) {
        return resolveNestedVariable(value, path);
    }

    // return the resolved value, if path is empty.
    return value;
}

var checkLoggingLevel = function(level, dynamicLogLevel) {
    var threshold;
    
    if(dynamicLogLevel != null) {
        threshold = dynamicLogLevel; // use dynamic log level
    } else {
        threshold = logLevelInt; // use global log level
    } 
    return (threshold >= loggingLevels[level]);
}

// Writes the given log file to stdout
var sendLog = function (logObject) {
    writeLogToConsole(logObject);
};

var setLogPattern = function (p) {
    pattern = p;
};

// Logs message and custom fields
//
// Simple
// logMessage("info", "Hello World"); >> ... "msg":"Hello World" ...
//
// With addtional numeric value
// logMessage("info", "Listening on port %d", 5000); >> ... "msg":"Listening on port 5000" ...
//
// With additional string values
// logMessage("info", "This %s a %s", "is", "test"); >> ... "msg":"This is a test" ...
//
// With custom fields (Added to custom_fields field) 
// logMessage("info", "Test data %j", {"field" :"value"}); >> ... "msg":"Test data %j" ... "custom_fields": {"field": "value"} ...
//
// With json object embedded in the message (nothing will be added to custom_fields)
// logMessage("info", "Test data %j", {"field" :"value"}, null); >> ... "msg":"Test data {\"field\": \"value\"}" ...
var logMessage = function () {
    var args = Array.prototype.slice.call(arguments);

    var dynamicLogLevel = this.dynamicLogLevel;
    
    var level = args[0];
    if (!checkLoggingLevel(level,this.dynamicLogLevel)) { 
            return false;
    } else {
        var logObject = initLog();
        logObject.level = level;
    }

    var customFields = null;

    args.shift();

    if (typeof args[args.length - 1] === 'object') {
        if (validObject(args[args.length - 1])) {
            customFields = args[args.length - 1];
        }
        args.pop();
    }

    var msg = util.format.apply(util, args);

    var req = this;
    if (req.logObject != null) {
        logObject.correlation_id = req.logObject.correlation_id;
        if (req.logObject.request_id != null) {
            logObject.request_id = req.logObject.request_id;
        }
    }

    logObject.msg = msg;

    logObject.type = logType;

    if (customFields != null) {
        logObject.custom_fields = customFields.constructor == Array ? [] : {};
        for (var key in customFields) {
            if (!((typeof customFields[key]) == "string")) {
                logObject.custom_fields[key] = JSON.stringify(customFields[key]);
            } else {
                logObject.custom_fields[key] = customFields[key];
            }
        }
    }

    sendLog(logObject);
    return true;
};

//getCorrelationId returns the current correlation id for the req this is called on
var getCorrelationId = function () {
    var req = this;
    if (req.logObject != null) {
        if (req.logObject.correlation_id != null) {
            return req.logObject.correlation_id;
        }
    }
    return null;
};

//setCorrelationId sets the Correlation_id for the request this is called on. Checks i the id is a correct uuid-v4. Returns true if set, false otherwise
var setCorrelationId = function (correlationId) {
    var req = this;
    if (req.logObject != null) {
        if (uuidCheck.exec(correlationId)) {
            req.logObject.correlation_id = correlationId;
            return true;
        }
    }
    return false;
}

var bindLogFunctions = function (req) {
    req.logMessage = logMessage;
    req.getCorrelationId = getCorrelationId;
    req.setCorrelationId = setCorrelationId;
    req.getCorrelationObject = getCorrelationObject;
    req.setDynamicLoggingLevel = setDynamicLoggingLevel;
}


var validObject = function (obj) {
    if (obj === null || obj === undefined) {
        return false;
    } else if (Object.keys(obj).length === 0 && obj.constructor === Object) {
        return false;
    } else if (typeof obj !== "object") {
        return false;
    }
    return true;
};

var getCorrelationObject = function () {
    var context = this;
    var newContext = {};
    newContext.logObject = {};
    if (context.logObject != null) {
        newContext.logObject.correlation_id = context.logObject.correlation_id;
    } else {
        newContext.logObject.correlation_id = uuid();
    }
    bindLogFunctions(newContext);
    return newContext;
}

// Sets the dynamic log level for the request to the given level
var setDynamicLoggingLevel = function(levelName) {
    var context = this;
    context.dynamicLogLevel = getLogLevelFromName(levelName);
}

var writeStaticFields = function (logObject) {
    for (var key in fixedValues) {
        logObject[key] = fixedValues[key];
    }
}

// overrides Values in ALL Network logs (will impact log parsing, so use with caution!), returns true if field is set.
var overrideField = function (field, value) {
    if (field != null && typeof field == "string") {
        if (value == undefined || value == null) {
            fixedValues[field] = null;
            return true;
        } else {
            fixedValues[field] = value;
            return true;
        }
    }
    return false;
}

// Get the name of the dynamic log level header
var getDynLogLevelHeaderName = function() {
    return dynLogLevelHeader;
}

// Get the dynamic logging level from the given JWT.
var getLogLevelFromJWT = function(token) {
    var payload = verifyAndDecodeJWT(token, dynLogLevelKey);

    if(payload == null) {
        return null;
    }

    var levelName = payload.level;

    return getLogLevelFromName(levelName);
}

// Gets the log level number from a given level name
var getLogLevelFromName = function(levelName) {
    if(levelName == null) return null;
    return loggingLevels[levelName.toLowerCase()];
}

// Verifies the given JWT and returns its payload.
var verifyAndDecodeJWT = function(token, key) {
    if(key == null || token == null) {
        return null; // no public key or jwt provided
    }

    try {
        return jwt.verify(token, "-----BEGIN PUBLIC KEY-----\n" + key + "\n-----END PUBLIC KEY-----", {algorithms: ["RS256", "RS384", "RS512"]});
    } catch(err) {
        return null; // token expired or invalid
    }
}


exports.checkLoggingLevel = checkLoggingLevel;
exports.init = init;
exports.overrideField = overrideField;
exports.writeStaticFields = writeStaticFields;
exports.reduceFields = reduceFields;
exports.setLoggingLevel = setLoggingLevel;
exports.getLoggingLevel = getLoggingLevel;
exports.initLog = initLog;
exports.sendLog = sendLog;
exports.logMessage = logMessage;
exports.validObject = validObject;
exports.setLogPattern = setLogPattern;
exports.bindLogFunctions = bindLogFunctions;
exports.getCorrelationObject = getCorrelationObject;
exports.setConfig = setConfig;
exports.getPostLogConfig = getPostLogConfig;
exports.getPreLogConfig = getPreLogConfig;
exports.handleConfigDefaults = handleConfigDefaults;
exports.getDynLogLevelHeaderName = getDynLogLevelHeaderName;
exports.getLogLevelFromJWT = getLogLevelFromJWT;