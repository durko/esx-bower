var crypto = require("crypto"),
    EventEmitter = require('events').EventEmitter,
    fs = require("fs"),
    path = require("path"),
    util = require('util');

var bower = require("bower"),
    _request = require("request"),
    recast = require("recast"),
    RSVP = require("rsvp"),
    semver = require("semver");



// promise api for required library functions
function thenify(fn) {
    return function() {
        var args = arguments;
        return new RSVP.Promise(function(resolve, reject) {
            fn.apply(this, args)
                .on("end", function(arg) { resolve(arg); })
                .on("error", function(err) { reject(err); });
        });
    };
}

var bowerList = thenify(bower.commands.list),
    bowerUpdate = thenify(bower.commands.update),
    readFile = RSVP.denodeify(fs.readFile),
    request = RSVP.denodeify(_request, ["res", "body"]),
    stat = RSVP.denodeify(fs.stat),
    writeFile = RSVP.denodeify(fs.writeFile);



function selectVersion(version, versions) {
    var ret = "0.0.0",
        k, ver;

    for (k in versions) {
        ver = versions[k];

        if (semver.gt(ver, version)) {
            continue;
        }
        if (semver.gt(ver, ret)) {
            ret = ver ;
        }
    }
    return ret;
}



var hooks = {
    "es6-modules": function(parameters, source) {
        var prefix = "";
        if (parameters.import) {
            parameters.import.forEach(function(p) {
                prefix += "import "+p.var+" from \""+p.module+"\";\n";
            });
        }
        var suffix = "\n";
        parameters.export.forEach(function(p) {
            suffix += "export "+p.name+" "+p.var+";\n";
        });
        return prefix + source + suffix;
    },
    "prepend": function(parameters, source) {
        return parameters + "\n" + source;
    },
    "append": function(parameters, source) {
        return source + "\n" + parameters;
    },
    "replace": function(parameters, src) {
        return src.replace(new RegExp(parameters.regex), parameters.replace);
    },
    "jquery-plugin": function(parameters, source) {
        var jquery = path.join(this.vendorPrefix, "jquery");
        return "" +
            "import $ from \"" + jquery + "\";\n" +
            "var jQuery = $, jquery = $;\n" +
            source +
            "\nexport default 0;";
    },
    "export": function(parameters, source) {
        return source +
            "\nexport default " + parameters.var;
    },
    "munge-ast": function(parameters, source) {
        var ast = recast.parse(source),
            value, target, right;

        parameters.forEach(function(transform) {
            /* jshint evil: true */
            if (transform.type === "unshift") {
                value = recast.parse(transform.value).program.body[0];
                eval("ast.program.body"+transform.key+".unshift(value);");
            } else if (transform.type === "push") {
                value = recast.parse(transform.value).program.body;
                target = eval("ast."+transform.key+"");
                while (value.length) {
                    ast.program.body.push(value.shift());
                }
            } else if (transform.type === "assign") {
                right = recast.parse(transform.right).program.body;
                (transform.rightReplace || []).forEach(function(subtransform) {
                    eval("right"+subtransform.left+" = ast.program.body"+
                        subtransform.right+";");
                });
                eval("ast.program.body"+transform.left+" = right[0];");
            }
        });
        return recast.print(ast).code;
    }
};



function Bower(options) {
    this.offline = options.offline || false;
    this.patches = options.patches ||
        "https://raw.githubusercontent.com/durko/esx-legacy/master/patch.json";
    this.baseDir = options.baseDir || "src";
    this.vendorPrefix = options.vendorPrefix || "";

    this.state = options.state || {};
    this.state.packages = this.state.packages || {};
}

util.inherits(Bower, EventEmitter);

Bower.prototype.init = function() {
    return this.loadBowerRc()
    .then(this.loadBowerJson.bind(this))
    .then(this.loadPatchSource.bind(this))
    .then(this.bowerList.bind(this))
    .then(this.bowerUpdateIfMissing.bind(this))
    .then(this.patch.bind(this));
};

Bower.prototype.loadBowerRc = function() {
    var _this = this;

    return readFile(".bowerrc")
    .then(function(json) {
        return JSON.parse(json);
    })
    .catch(function() {
        return {};
    })
    .then(function(bowerrc) {
        _this.state.bowerrc = bowerrc;
        _this.state.directory = bowerrc.directory || "bower_components";
    });
};
Bower.prototype.loadBowerJson = function() {
    var _this = this;

    return readFile("bower.json")
    .catch(function() {
        return "{}";
    })
    .then(function(bowerjson) {
        _this.state.bowerjson = bowerjson;
    });
};

Bower.prototype.loadPatchSource = function() {
    var _this = this,
        p;
    if (/^http/.test(this.patches)) {
        p = request(this.patches).then(function(r) {
            if (r.res.statusCode < 300) {
                return r.body;
            } else {
                throw Error("Could not download legacy patches from " +
                    r.res.request.href);
            }
        });
    } else {
        p = readFile(this.patches);
    }

    return p.then(function(r) {
        _this.state.patches = JSON.parse(r);
    })
    .catch(function(err) {
        console.log("ES6T loading failed");
        console.log(err);
        throw err;
    });
};

Bower.prototype.getPkgPatches = function(name, version) {
    var pkgspec = this.state.patches[name]||{},
        bestVersion = selectVersion(version, Object.keys(pkgspec));

    return pkgspec[bestVersion];
};

Bower.prototype.extractBowerPackages = function(descriptions) {
    var packages = this.state.packages,
        directory = this.state.directory,
        name, desc, version, files, patches, k, v;

    function sanitizePaths(name, paths) {
        if (!paths) {
            return [];
        }
        if (!Array.isArray(paths)) {
            paths = [ paths ];
        }

        return paths.map(function(filename) {
            return filename.replace(/^\.\//, "");
        }).filter(function(filename) {
            return filename !== path.join(directory, name);
        });
    }

    for (name in descriptions) {
        desc = descriptions[name];
        if (desc.missing) {
            continue;
        }

        version = desc.pkgMeta.version || "0.0.0";
        files = sanitizePaths(name, desc.pkgMeta.main);
        patches = this.getPkgPatches(name, version);

        for (k in patches) {
            v = patches[k];

            if (k === "_add") {
                for (k in v) {
                    files.push(v[k]);
                }
            } else {
                if (!~files.indexOf(k)) {
                    files.push(k);
                }
            }
        }

        packages[name] = {
            version: version,
            files: files,
            patches: patches
        };

        this.extractBowerPackages(desc.dependencies);
    }
};

Bower.prototype.bowerUpdate = function() {
    var _this = this,
        hash = crypto.createHash("sha1");

    hash.update(this.state.bowerjson||"");

    var digest = hash.digest("hex");

    // config unchanged, bower was already run
    if (this.state.bowerHash === digest) {
        return RSVP.resolve();
    }

    // config has changed
    var options = {
        offline: this.offline
    };

    return bowerUpdate([], options, this.state.bowerrc)
    .then(function(updated) {
        var pkg;

        for (pkg in updated) {
            _this.emit("installed", {
                name: pkg,
                version: updated[pkg].pkgMeta.version
            });
        }
        _this.extractBowerPackages(updated);
        _this.state.bowerHash = digest;
        return updated;
    });
};

Bower.prototype.bowerUpdateIfMissing = function() {
    var required = Object.keys(JSON.parse(this.state.bowerjson).dependencies),
        packages = this.state.packages;

    var shouldUpdate = !required.every(function(name) {
        return !!packages[name];
    });

    if (shouldUpdate) {
        return this.bowerUpdate();
    }
};

Bower.prototype.bowerList = function() {
    var _this = this;

    return bowerList({ options:false }, this.state.bowerrc)
    .then(function(pkg) {
        _this.extractBowerPackages(pkg.dependencies);

        return pkg;
    });
};

Bower.prototype.pkgConfig = function() {
    var pkgs = [],
        name, pkg, js, filename;

    function isJs(f) { return /\.js$/.test(f); }

    for (name in this.state.packages) {
        pkg = this.state.packages[name];

        js = pkg.files.filter(isJs);
        if (!js.length) {
            continue;
        }

        filename = js[0];
        if (pkg.patches && pkg.patches[filename]) {
            filename = filename.replace(/\.js$/, ".es6.js");
        }
        filename = path.join(this.state.directory, name, filename);

        pkgs.push({
            name: path.join(this.vendorPrefix, name),
            main: path.basename(filename).replace(/\.js$/, ""),
            location: path.relative(this.baseDir, path.dirname(filename))
        });
    }

    return pkgs;
};

Bower.prototype.filenames = function() {
    var directory = this.state.directory,
        filenames = [],
        name, pkg, i, len, filename;

    for (name in this.state.packages) {
        pkg = this.state.packages[name];
        for (i=0, len=pkg.files.length; i<len; i++) {
            filename = pkg.files[i];
            if (pkg.patches && pkg.patches[filename]) {
                filename = filename.replace(/\.js$/, ".es6.js");
            }
            filenames.push(path.join(directory, name, filename));
        }
    }
    return filenames;
};

Bower.prototype.jsForPkg = function(pkg, names) {
    var directory = this.state.directory,
        files = names.length ? names : this.state.packages[pkg].files;

    function isJs(f) { return /\.js$/.test(f); }
    return files.filter(isJs).map(function(f) {
        return path.join(directory, pkg, f);
    });
};

Bower.prototype.patch = function() {
    var _this = this,
        name, pkg, i, len, filename;

    function ptc(filename, patches) {
        var patchedname = filename.replace(/\.js$/, ".es6.js");

        return stat(patchedname)
        .then(function(pstats) {
            return stat(filename)
            .then(function(ostats) {
                return ostats.mtime.getTime() > pstats.mtime.getTime();
            });
        })
        .catch(function() {
            return true;
        })
        .then(function(build) {
            if (build) {
                return readFile(filename)
                .then(function(content) {
                    var i, transform;
                    for (i in patches) {
                        transform = patches[i];
                        content = hooks[transform.type].call(_this,
                            transform.parameters,
                            content
                        );
                    }
                    return writeFile(patchedname, content);
                });
            }
        });
    }

    var promises = [];
    for (name in this.state.packages) {
        pkg = this.state.packages[name];

        for (i=0, len=pkg.files.length; i<len; i++) {
            filename = pkg.files[i];
            if (pkg.patches && pkg.patches[filename]) {
                promises.push(ptc(
                    path.join(this.state.directory, name, filename),
                    pkg.patches[filename])
                );
            }
        }
    }
    return RSVP.all(promises);
};

module.exports.Bower = Bower;
