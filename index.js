var through = require('through');
var duplexer = require('duplexer');
var commondir = require('commondir');
var checkSyntax = require('syntax-error');

var mdeps = require('module-deps');
var browserPack = require('browser-pack');
var parseScope = require('lexical-scope');
var browserResolve = require('browser-resolve');

var path = require('path');
var inherits = require('inherits');
var EventEmitter = require('events').EventEmitter;

module.exports = function (files) {
    return new Browserify(files);
};

inherits(Browserify, EventEmitter);

function Browserify (files) {
    this.files = [];
    this.exports = {};
    this._globals = {};
    this._pending = 0;
    this._entries = [];
    
    [].concat(files).filter(Boolean).forEach(this.add.bind(this));
}

Browserify.prototype.add = function (file) {
    file = path.resolve(file);
    this.files.push(file);
    this._entries.push(file);
};

Browserify.prototype.require = function (name, fromFile) {
    var self = this;
    if (!fromFile) {
        fromFile =path.join(process.cwd(), '_fake');
    }
    self._pending ++;
    
    var opts = { filename: fromFile, packageFilter: packageFilter };
    browserResolve(name, opts, function (err, file) {
        if (err) return self.emit('error', err);
        self.expose(name, file);
        if (--self._pending === 0) self.emit('_ready');
    });
    
    return self;
};

Browserify.prototype.expose = function (name, file) {
    this.exports[file] = name;
    this.files.push(file);
};

Browserify.prototype.bundle = function (cb) {
    var self = this;
    
    if (self._pending) {
        var tr = through();
        
        self.on('_ready', function () {
            self.bundle(cb).pipe(tr);
        });
        return tr;
    }
    
    var d = self.deps()
    var g = self.insertGlobals();
    var p = self.pack();
    d.pipe(g).pipe(p);
    
    if (cb) {
        var data = '';
        p.on('data', function (buf) { data += buf });
        p.on('end', function () { cb(null, data) });
        d.on('error', cb);
        p.on('error', cb);
    }
    else {
        d.on('error', self.emit.bind(self, 'error'));
        p.on('error', self.emit.bind(self, 'error'));
    }
    
    return p;
};

Browserify.prototype.deps = function () {
    var self = this;
    var d = mdeps(self.files, { resolve: self._resolve.bind(self) });
    return d.pipe(through(function (row) {
        var ix = self._entries.indexOf(row.id);
        row.entry = ix >= 0;
        if (ix >= 0) row.order = ix;
        this.queue(row);
    }));
};

var processModulePath = require.resolve('process/browser.js');
Browserify.prototype.insertGlobals = function () {
    var self = this;
    var basedir = self.files.length
        ? commondir(self.files.map(path.dirname))
        : '/'
    ;
    
    return through(function (row) {
        var tr = this;
        if (!/\bprocess\b/.test(row.source)
            && !/\bglobal\b/.test(row.source)
            && !/\b__filename\b/.test(row.source)
            && !/\b__dirname\b/.test(row.source)
        ) return tr.queue(row);
        
        var scope = parseScope(row.source);
        var globals = {};
        
        if (scope.globals.implicit.indexOf('process') >= 0) {
            if (!self._globals.process) {
                tr.pause();
                
                var resolver = self._resolve.bind(self);
                var d = mdeps(processModulePath, { resolve: resolver });
                d.on('data', function (r) {
                    r.entry = false;
                    tr.emit('data', r);
                });
                d.on('end', function () { tr.resume() });
            }
            
            self._globals.process = true;
            row.deps.__browserify_process = processModulePath;
            globals.process = 'require("__browserify_process")';
        }
        if (scope.globals.implicit.indexOf('global') >= 0) {
            globals.global = 'window';
        }
        if (scope.globals.implicit.indexOf('__filename') >= 0) {
            var file = '/' + path.relative(basedir, row.id);
            globals.__filename = JSON.stringify(file);
        }
        if (scope.globals.implicit.indexOf('__dirname') >= 0) {
            var dir = path.dirname('/' + path.relative(basedir, row.id));
            globals.__dirname = JSON.stringify(dir);
        }
        
        var keys = Object.keys(globals);
        row.source = '(function(' + keys + '){' + row.source + '\n})('
            + keys.map(function (key) { return globals[key] }).join(',') + ')'
        ;
        
        tr.queue(row);
    });
};

Browserify.prototype.pack = function () {
    var self = this;
    var packer = browserPack({ raw: true });
    var ids = {};
    var idIndex = 0;
    
    var input = through(function (row) {
        var ix;
        if (self.exports[row.id] !== undefined) {
            ix = self.exports[row.id];
        }
        else {
            ix = ids[row.id] !== undefined ? ids[row.id] : idIndex++;
        }
        if (ids[row.id] === undefined) ids[row.id] = ix;
        
        if (/\.json$/.test(row.id)) {
            row.source = 'module.exports=' + row.source;
        }
        
        var err = checkSyntax(row.source, row.id);
        if (err) self.emit('error', err);
        
        row.id = ix;
        row.deps = Object.keys(row.deps).reduce(function (acc, key) {
            var file = row.deps[key];
            if (ids[file] === undefined) ids[file] = idIndex++;
            acc[key] = ids[file];
            return acc;
        }, {});
        this.queue(row);
    });
    
    var first = true;
    var hasExports = Object.keys(self.exports).length;
    var output = through(write, end);
    
    function writePrelude () {
        if (!first) return;
        if (!hasExports) return output.queue(';');
        output.queue([
            'require=(function(o,r){',
                'return function(n){',
                    'var x=r(n);',
                    'if(x!==undefined)return x;',
                    'if(o)return o(n);',
                    'throw new Error("Cannot find module \'"+n+"\'")',
                '}',
            '})(typeof require!=="undefined"&&require,',
        ].join(''));
    }
    
    input.pipe(packer);
    packer.pipe(output);
    return duplexer(input, output);
    
    function write (buf) {
        if (first) writePrelude();
        first = false;
        this.queue(buf);
    }
    
    function end () {
        if (first) writePrelude();
        this.queue(hasExports ? ');' : ';');
        this.emit('end');
    }
};

var packageFilter = function (info) {
    if (info.browserify && !info.browser) {
        info.browser = info.browserify;
    }
    return info;
};

Browserify.prototype._resolve = function (id, parent, cb) {
    parent.packageFilter = packageFilter;
    return browserResolve(id, parent, cb);
};

Browserify.prototype.ignore = function (file) {
};
