/// <reference path="emitter/util.ts"/>

namespace ks.cpp {
    import U = ts.ks.Util;
    import Y = ts.ks;
    let lf = U.lf;

    function parseExpr(e: string): number {
        e = e.trim()
        e = e.replace(/^\(/, "")
        e = e.replace(/\)$/, "")
        e = e.trim();
        if (/^-/.test(e) && parseExpr(e.slice(1)) != null)
            return -parseExpr(e.slice(1))
        if (/^0x[0-9a-f]+$/i.exec(e))
            return parseInt(e.slice(2), 16)
        if (/^0b[01]+$/i.exec(e))
            return parseInt(e.slice(2), 2)
        if (/^0\d+$/i.exec(e))
            return parseInt(e, 8)
        if (/^\d+$/i.exec(e))
            return parseInt(e, 10)
        return null;
    }

    export function getExtensionInfo(mainPkg: MainPackage): Y.ExtensionInfo {
        var res = Y.emptyExtInfo();
        var pointersInc = ""
        var includesInc = ""
        var thisErrors = ""
        var err = (s: string) => thisErrors += "   " + s + "\n";
        var cfginc = ""

        function parseCpp(src: string) {
            res.hasExtension = true
            var currNs = ""
            src.split(/\r?\n/).forEach(ln => {
                var m = /^\s*namespace\s+(\w+)/.exec(ln)
                if (m) {
                    if (currNs) err("more than one namespace declaration not supported")
                    currNs = m[1]
                    return;
                }

                m = /^\s*GLUE\s+(\w+)([\*\&]*\s+[\*\&]*)(\w+)\s*\(([^\(\)]*)\)\s*(;\s*$|\{|$)/.exec(ln)
                if (m) {
                    if (!currNs) err("missing namespace declaration before GLUE");
                    var retTp = (m[1] + m[2]).replace(/\s+/g, "")
                    var funName = m[3]
                    var args = m[4]
                    var numArgs = 0
                    if (args.trim())
                        numArgs = args.replace(/[^,]/g, "").length + 1;
                    var fi: Y.FuncInfo = {
                        name: currNs + "::" + funName,
                        type: retTp == "void" ? "P" : "F",
                        args: numArgs,
                        value: null
                    }
                    res.functions.push(fi)
                    pointersInc += "(uint32_t)(void*)::" + fi.name + ",\n"
                    return;
                }

                if (/^\s*GLUE\s+/.test(ln)) {
                    err("invalid GLUE line: " + ln)
                    return;
                }

                ln = ln.replace(/\/\/.*/, "")
                var isEnum = false
                m = /^\s*#define\s+(\w+)\s+(.*)/.exec(ln)
                if (!m) {
                    m = /^\s*(\w+)\s*=\s*(.*)/.exec(ln)
                    isEnum = true
                }

                if (m) {
                    var num = m[2]
                    num = num.replace(/\/\/.*/, "")
                    num = num.replace(/\/\*.*/, "")
                    num = num.trim()
                    if (isEnum)
                        num = num.replace(/,$/, "")
                    var val = parseExpr(num)
                    var nm = m[1]
                    if (isEnum)
                        nm = currNs + "::" + nm
                    //console.log(nm, num, val)
                    if (val != null) {
                        res.enums[nm] = val
                        return;
                    }
                }
            })
        }

        function parseJson(pkg: Package) {
            let json = pkg.config.microbit
            if (!json) return;

            res.hasExtension = true

            // TODO check for conflicts
            if (json.dependencies) {
                U.jsonCopyFrom(res.microbitConfig.dependencies, json.dependencies)
            }

            if (json.config)
                Object.keys(json.config).forEach(k => {
                    if (!/^\w+$/.test(k))
                        err(lf("invalid config variable: {0}", k))
                    cfginc += "#undef " + k + "\n"
                    if (!/^\w+$/.test(json.config[k]))
                        err(lf("invalid config value: {0}: {1}", k, json.config[k]))
                    cfginc += "#define " + k + " " + json.config[k] + "\n"
                })
        }

        res.microbitConfig.dependencies["kindscript-microbit-core"] = "microsoft/kindscript-microbit-core#master";

        if (mainPkg) {
            // TODO computeReachableNodes(pkg, true)
            for (let pkg of mainPkg.sortedDeps()) {
                thisErrors = ""
                parseJson(pkg)
                for (let fn of pkg.getFiles()) {
                    if (U.endsWith(fn, ".cpp")) {
                        let src = pkg.readFile(fn)
                        parseCpp(src)
                        let fullName = pkg.level == 0 ? fn : "kind_modules/" + pkg.id + "/" + fn
                        res.extensionFiles["/ext/" + fullName] = src
                        includesInc += `#include "${fullName}"\n`
                    }
                }
                if (thisErrors) {
                    res.errors += lf("Packge {0}:\n", pkg.id) + thisErrors
                }
            }
        }

        if (res.errors)
            return res;

        res.generatedFiles["/ext/config.h"] = cfginc
        res.generatedFiles["/ext/pointers.inc"] = pointersInc
        res.generatedFiles["/ext/refs.inc"] = includesInc

        let moduleJson = {
            "name": "kindscript-microbit-app",
            "version": "0.0.0",
            "description": "Auto-generated. Do not edit.",
            "license": "n/a",
            "dependencies": res.microbitConfig.dependencies,
            "targetDependencies": {},
            "bin": "./source"
        }

        let configJson = {
            "microbit": {
                "configfile": "inc/MicroBitCustomConfig.h"
            }
        }

        res.generatedFiles["/module.json"] = JSON.stringify(moduleJson, null, 4) + "\n"
        res.generatedFiles["/config.json"] = JSON.stringify(configJson, null, 4) + "\n"
        res.generatedFiles["/source/main.cpp"] = `#include "BitVM.h"\nvoid app_main() { bitvm::start(); }\n`

        let tmp = res.extensionFiles
        U.jsonCopyFrom(tmp, res.generatedFiles)

        var creq = {
            config: "ws",
            tag: "v75",
            replaceFiles: tmp,
            dependencies: res.microbitConfig.dependencies,
        }

        let data = JSON.stringify(creq)
        res.sha = U.sha256(data)
        res.compileData = btoa(U.toUTF8(data))

        return res;
    }

    function fileReadAsArrayBufferAsync(f: File): Promise<ArrayBuffer> { // ArrayBuffer
        if (!f)
            return Promise.resolve<ArrayBuffer>(null);
        else {
            return new Promise<ArrayBuffer>((resolve, reject) => {
                var reader = new FileReader();
                reader.onerror = (ev) => resolve(null);
                reader.onload = (ev) => resolve(reader.result);
                reader.readAsArrayBuffer(f);
            });
        }
    }

    function fromUTF8Bytes(binstr: Uint8Array) : string {
        if (!binstr) return ""

        // escape function is deprecated
        var escaped = ""
        for (var i = 0; i < binstr.length; ++i) {
            var k = binstr[i] & 0xff
            if (k == 37 || k > 0x7f) {
                escaped += "%" + k.toString(16);
            } else {
                escaped += String.fromCharCode(k)
            }
        }

        // decodeURIComponent does the actual UTF8 decoding
        return decodeURIComponent(escaped)
    }

    function lzmaDecompressAsync(buf: Uint8Array): Promise<string> { // string
        var lzma = (<any>window).LZMA;
        if (!lzma) return Promise.resolve<string>(undefined);
        return new Promise<string>((resolve, reject) => {
            try {
                lzma.decompress(buf, (res: string, error: any) => {
                    resolve(error ? undefined : res);
                })
            }
            catch (e) {
                resolve(undefined);
            }
        })
    }

    function lzmaCompressAsync(text: string): Promise<Uint8Array> { // UInt8Array
        var lzma = (<any>window).LZMA;
        if (!lzma) return Promise.resolve<Uint8Array>(undefined);
        return new Promise<Uint8Array>((resolve, reject) => {
            try {
                lzma.compress(text, 7, (res: any, error: any) => {
                    resolve(error ? undefined : new Uint8Array(res));
                })
            }
            catch (e) {
                resolve(undefined);
            }
        })
    }    
    
    function swapBytes(str:string) : string
    {
        var r = ""
        for (var i = 0; i < str.length; i += 2)
            r = str[i] + str[i + 1] + r
        Util.assert(i == str.length)
        return r
    }
        
    function extractSource(hexfile: string): { meta: string; text: Uint8Array; }
    {
        if (!hexfile) return undefined;

        var metaLen = 0
        var textLen = 0
        var toGo = 0
        var buf: number[];
        var ptr = 0;
        hexfile.split(/\r?\n/).forEach(ln => {
            var m = /^:10....0041140E2FB82FA2BB(....)(....)(....)(....)(..)/.exec(ln)
            if (m) {
                metaLen = parseInt(swapBytes(m[1]), 16)
                textLen = parseInt(swapBytes(m[2]), 16)
                toGo = metaLen + textLen
                buf = <any>new Uint8Array(toGo)
            } else if (toGo > 0) {
                m = /^:10....00(.*)(..)$/.exec(ln)
                if (!m) return
                var k = m[1]
                while (toGo > 0 && k.length > 0) {
                    buf[ptr++] = parseInt(k[0] + k[1], 16)
                    k = k.slice(2)
                    toGo--
                }
            }
        })
        if (!buf || !(toGo == 0 && ptr == buf.length)) {
            return undefined;
        }
        var bufmeta = new Uint8Array(metaLen)
        var buftext = new Uint8Array(textLen)
        for (var i = 0; i < metaLen; ++i)
            bufmeta[i] = buf[i];
        for (var i = 0; i < textLen; ++i)
            buftext[i] = buf[metaLen + i];
        // iOS Safari doesn't seem to have slice() on Uint8Array
        return {
            meta: fromUTF8Bytes(bufmeta),
            text: buftext
        }
    }

    export function unpackSourceFromHexFileAsync(file: File): Promise<{ meta?: { cloudId: string; editor:string; }; source: string; }> { // string[] (guid)
        if (!file) return undefined;

        return fileReadAsArrayBufferAsync(file)
            .then((dat : ArrayBuffer) => {
                let str = fromUTF8Bytes(new Uint8Array(dat));
                let tmp = extractSource(str || "")
                if (!tmp) return undefined

                if (!tmp.meta || !tmp.text) {
                    console.log("This .hex file doesn't contain source.")
                    return undefined;
                }
                
                var hd: { compression:string; headerSize: number; metaSize: number; editor: string; target?:string; } = JSON.parse(tmp.meta)
                if (!hd) {
                    console.log("This .hex file is not valid.")
                    return undefined;
                }
                else if (hd.compression == "LZMA") {
                    return lzmaDecompressAsync(tmp.text)
                        .then(res => {
                            if (!res) return null;
                            let meta = res.slice(0, hd.headerSize || hd.metaSize);
                            let text = res.slice(meta.length);
                            let metajs = JSON.parse(meta);
                            return {  meta: metajs, source: text }
                        })
                } else if (hd.compression) {
                    console.log("Compression type {0} not supported.", hd.compression)
                    return undefined
                } else {
                    return { meta:undefined, source: fromUTF8Bytes(tmp.text) };
                }
            })
    }
}
