var mongoose = require('mongoose'),
    Schema = mongoose.Schema,
    Model = mongoose.Model,
    util = require('util');

/**
 * This code is taken from official mongoose repository
 * https://github.com/Automattic/mongoose/blob/master/lib/query.js#L3847-L3873
 */
function parseUpdateArguments (conditions, doc, options, callback) {
    if ('function' === typeof options) {
        // .update(conditions, doc, callback)
        callback = options;
        options = null;
    } else if ('function' === typeof doc) {
        // .update(doc, callback);
        callback = doc;
        doc = conditions;
        conditions = {};
        options = null;
    } else if ('function' === typeof conditions) {
        // .update(callback)
        callback = conditions;
        conditions = undefined;
        doc = undefined;
        options = undefined;
    } else if (typeof conditions === 'object' && !doc && !options && !callback) {
        // .update(doc)
        doc = conditions;
        conditions = undefined;
        options = undefined;
        callback = undefined;
    }

    var args = [];

    if (conditions) args.push(conditions);
    if (doc) args.push(doc);
    if (options) args.push(options);
    if (callback) args.push(callback);

    return args;
}

function parseIndexFields (options) {
    var indexFields = {
        deleted: false,
        deletedAt: false,
        deletedBy: false,
        deletedId: false,
    };

    if (!options.indexFields) {
        return indexFields;
    }

    if ((typeof options.indexFields === 'string' || options.indexFields instanceof String) && options.indexFields === 'all') {
        indexFields.deleted = indexFields.deletedAt = indexFields.deletedBy = true;
    }

    if (typeof(options.indexFields) === "boolean" && options.indexFields === true) {
        indexFields.deleted = indexFields.deletedAt = indexFields.deletedBy = indexFields.deletedId = true;
    }

    if (Array.isArray(options.indexFields)) {
        indexFields.deleted = options.indexFields.indexOf('deleted') > -1;
        indexFields.deletedAt = options.indexFields.indexOf('deletedAt') > -1;
        indexFields.deletedBy = options.indexFields.indexOf('deletedBy') > -1;
        indexFields.deletedId = options.indexFields.indexOf('deletedId') > -1;

    }

    return indexFields;
}

function createSchemaObject (typeKey, typeValue, options) {
    options[typeKey] = typeValue;
    return options;
}

module.exports = function (schema, options) {
    options = options || {};
    var indexFields = parseIndexFields(options);

    var typeKey = schema.options.typeKey;
    var mongooseMajorVersion = +mongoose.version[0]; // 4, 5...
    var mainUpdateMethod = mongooseMajorVersion < 5 ? 'update' : 'updateMany';
    var mainUpdateWithDeletedMethod = mainUpdateMethod + 'WithDeleted';

    function updateDocumentsByQuery(schema, conditions, updateQuery, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = { multi: true };
        } else if (!options) {
            options = { multi: true };
        } else {
            options = { ...options, multi: true };
        }
        if (schema[mainUpdateWithDeletedMethod]) {
            return schema[mainUpdateWithDeletedMethod](conditions, updateQuery, options, callback);
        } else {
            return schema[mainUpdateMethod](conditions, updateQuery, options, callback);
        }
    }

    schema.add({ deleted: createSchemaObject(typeKey, Boolean, { default: false, index: indexFields.deleted }) });

    if (options.deletedAt === true) {
        schema.add({ deletedAt: createSchemaObject(typeKey, Date, { index: indexFields.deletedAt }) });
    }

    if (options.deletedBy === true) {
        schema.add({ deletedBy: createSchemaObject(typeKey, options.deletedByType || Schema.Types.ObjectId, { index: indexFields.deletedBy }) });
    }

    if (options.deletedId === true) {
        schema.add({ deletedId: createSchemaObject(typeKey, options.deletedIdType || Schema.Types.ObjectId, { index: indexFields.deletedId }) });
    }

    var use$neOperator = true;
    if (options.use$neOperator !== undefined && typeof options.use$neOperator === "boolean") {
        use$neOperator = options.use$neOperator;
    }

    schema.pre('save', function (next) {
        if (!this.deleted) {
            this.deleted = false;
        }
        next();
    });

    if (options.overrideMethods) {
        var overrideItems = options.overrideMethods;
        var overridableMethods = ['count', 'countDocuments', 'find', 'findOne', 'findOneAndUpdate', 'update', 'updateOne', 'updateMany', 'aggregate'];
        var finalList = [];

        if ((typeof overrideItems === 'string' || overrideItems instanceof String) && overrideItems === 'all') {
            finalList = overridableMethods;
        }

        if (typeof(overrideItems) === "boolean" && overrideItems === true) {
            finalList = overridableMethods;
        }

        if (Array.isArray(overrideItems)) {
            overrideItems.forEach(function(method) {
                if (overridableMethods.indexOf(method) > -1) {
                    finalList.push(method);
                }
            });
        }

        if (finalList.indexOf('aggregate') > -1) {
            schema.pre('aggregate', function() {
                var firstMatch = this.pipeline()[0];

                if(firstMatch.$match?.deleted?.$ne !== false){
                    if(firstMatch.$match?.showAllDocuments === 'true'){
                        var {showAllDocuments, ...replacement} = firstMatch.$match;
                        this.pipeline().shift();
                        if(Object.keys(replacement).length > 0){
                            this.pipeline().unshift({ $match: replacement });
                        }
                    }else{
                        this.pipeline().unshift({ $match: { deleted: { '$ne': true } } });
                    }
                }
            });
        }

        finalList.forEach(function(method) {
            if (['count', 'countDocuments', 'find', 'findOne'].indexOf(method) > -1) {
                var modelMethodName = method;

                schema.statics[method] = function () {
                    var query = Model[modelMethodName].apply(this, arguments);
                    if (!arguments[2] || arguments[2].withDeleted !== true) {
                        if (use$neOperator) {
                            query.where('deleted').ne(true);
                        } else {
                            query.where({deleted: false});
                        }
                    }
                    return query;
                };
                schema.statics[method + 'Deleted'] = function () {
                    if (use$neOperator) {
                        return Model[modelMethodName].apply(this, arguments).where('deleted').ne(false);
                    } else {
                        return Model[modelMethodName].apply(this, arguments).where({deleted: true});
                    }
                };
                schema.statics[method + 'WithDeleted'] = function () {
                    return Model[modelMethodName].apply(this, arguments);
                };
            } else {
                if (method === 'aggregate') {
                    schema.statics[method + 'Deleted'] = function () {
                        var args = [];
                        Array.prototype.push.apply(args, arguments);
                        var session;
                        var lastArg = arguments[arguments.length - 1];
                        if (lastArg && typeof lastArg === 'object' && lastArg.session) {
                            session = lastArg.session;
                        }
                        var match = { $match : { deleted : {'$ne': false } } };
                        arguments.length ? args[0].unshift(match) : args.push([match]);
                         // Pass the session in the options if present
                        if (session) {
                            return Model[method].apply(this, args).session(session);
                        }
                        return Model[method].apply(this, args);
                    };

                    schema.statics[method + 'WithDeleted'] = function () {
                        var args = [];
                        Array.prototype.push.apply(args, arguments);
                        var session;
                        var lastArg = arguments[arguments.length - 1];
                        if (lastArg && typeof lastArg === 'object' && lastArg.session) {
                            session = lastArg.session;
                        }
                        var match = { $match : { showAllDocuments : 'true' } };
                        arguments.length ? args[0].unshift(match) : args.push([match]);
                        if (session) {
                            return Model[method].apply(this, args).session(session);
                        }
                        return Model[method].apply(this, args);
                    };
                } else {
                    schema.statics[method] = function () {
                        var args = parseUpdateArguments.apply(undefined, arguments);

                        if (use$neOperator) {
                            args[0].deleted = {'$ne': true};
                        } else {
                            args[0].deleted = false;
                        }
                        
                        return Model[method].apply(this, args);
                    };

                    schema.statics[method + 'Deleted'] = function () {
                        var args = parseUpdateArguments.apply(undefined, arguments);

                        if (use$neOperator) {
                            args[0].deleted = {'$ne': false};
                        } else {
                            args[0].deleted = true;
                        }

                        return Model[method].apply(this, args);
                    };

                    schema.statics[method + 'WithDeleted'] = function () {
                        return Model[method].apply(this, arguments);
                    };
                }
            }
        });
    }

    schema.methods.delete = function (params = {}, cb) {
        if (typeof params === 'function') {
            cb = params;
            params = {};
        }

        // If options is a string or ObjectId, it's the deletedBy value
        if (typeof params === 'string' || params instanceof mongoose.Types.ObjectId) {
            params = { deletedBy: params };
        } 

        this.deleted = true;

        if (schema.path('deletedAt')) {
            this.deletedAt = new Date();
        }

        if (schema.path('deletedBy')) {
            this.deletedBy = params.deletedBy;
        }

        if (schema.path('deletedId')) {
            this.deletedId = params.deletedId
        }

        if (schema.path('deletedId')) {
            this.deletedId = params.deletedId
        }

        if (options.validateBeforeDelete === false) {
            return this.save({ validateBeforeSave: false }, cb);
        }

        if(options.validateBeforeDelete === false) {
            saveOptions.validateBeforeSave = false;
        }

        return this.save(saveOptions, cb);
    };

    schema.statics.delete =  function (conditions, params = {}, callback) {
        if (typeof params === 'function') {
            callback = params;
            params = {};
        } else if (typeof conditions === 'function') {
            callback = conditions;
            conditions = {};
        } else if (typeof params === 'string' || params instanceof mongoose.Types.ObjectId) {
            params = { deletedBy: params };
        } 

        var doc = {
            deleted: true
        };

        if (schema.path('deletedAt')) {
            doc.deletedAt = new Date();
        }

        if (schema.path('deletedBy')) {
            doc.deletedBy = params.deletedBy;
        }

        if (schema.path('deletedId')) {
            doc.deletedId = params.deletedId 
        }

        if (schema.path('deletedId')) {
            doc.deletedId = params.deletedId 
        }


        return updateDocumentsByQuery(this, conditions, doc, callback);
    };

    schema.statics.deleteById =  function (id, params = {}, callback) {
        if (typeof params === 'function') {
            callback = params;
            params = {};
        } else if (typeof params === 'string' || params instanceof mongoose.Types.ObjectId) {
            params = { deletedBy: params };
        }
        
        if (arguments.length === 0 || typeof id === 'function') {
            var msg = 'First argument is mandatory and must not be a function.';
            throw new TypeError(msg);
        }

        var conditions = {
            _id: id
        };

        return this.delete(conditions, params, callback);
    };

    schema.methods.restore = function ( params = {}, callback) {
        if (typeof params === 'function') {
            cb = params;
            params = {};
        }

        this.deleted = false;
        this.deletedAt = undefined;
        this.deletedBy = undefined;
        this.deletedId = undefined;

        var saveOptions = {};
        if (params.session) {
            saveOptions.session = params.session;
        }

        if (options.validateBeforeRestore === false) {
            saveOptions.validateBeforeSave = false;
        }

        return this.save(saveOptions, callback);
    };

    schema.statics.restore =  function (conditions, params = {}, callback) {
        if (typeof conditions === 'function') {
            callback = conditions;
            conditions = {};
        }

        var doc = {
            $unset:{
                deleted: true,
                deletedAt: true,
                deletedBy: true,
                deletedId: true,
            }
        };
        
        const saveOptions = {};
        if (params.session) {
            saveOptions.session = params.session;
        }

        return updateDocumentsByQuery(this, conditions, doc, saveOptions, callback);
    };
};
