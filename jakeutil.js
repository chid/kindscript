"use strict";

var child_process = require("child_process");
var fs = require("fs");
var util = require("util");

// for use with child_process.exec/execFile
function execCallback(task) {
    return function (error, stdout, stderr) {
        if (stdout) console.log(stdout.toString().replace(/\n$/, ""));
        if (stderr) console.error(stderr.toString().replace(/\n$/, ""));
        if (error) {
            console.error(error);
            task.fail(error);
        }
        else task.complete();
    }
}

function expand1(dirs) {
    if (!Array.isArray(dirs))
        dirs = [dirs]
    let r = []
    dirs.forEach(dir =>
        fs.readdirSync(dir).forEach(f => r.push(dir + "/" + f)))
    return r
}

function expand(dir, ext) {
    function expandCore(dir) {
        if (Array.isArray(dir)) {
            let r = []
            dir.forEach(f => expandCore(f).forEach(x => r.push(x)))
            return r
        }
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory())
            return expandCore(fs.readdirSync(dir).map(f => dir + "/" + f))
        else {
            if (ext && dir.slice(-ext.length) != ext)
                return []
            return [dir]
        }
    }

    var res = expandCore(dir) 
    //console.log("expand:", dir, res)
    return res
}

function catFiles(out, files, pref) {
    if (pref == null) pref = '"use strict";'
    file(out, files, function () {
        console.log("[cat] " + out + " <- " + files.join(" "))
        let cont = files.map(f => fs.readFileSync(f, "utf8").replace(/\r/g, ""))
        cont.unshift(pref)
        fs.writeFileSync(out, cont.join("\n"))
    })
}

function cmdsIn(task, cmds) {
    let num = cmds.length
    cmds.forEach(obj => {
        console.log(`[${task.name}] cd ${obj.dir}; ${obj.cmd} ${obj.args.join(" ")}`)
        let ch = child_process.spawn(obj.cmd, obj.args, {
            cwd: obj.dir,
            env: process.env,
            stdio: "inherit"
        })
        ch.on('close', (code) => {
            if (code != 0)
                task.fail();
            else {
                if (--num == 0)
                    task.complete();
            }
        });
    })
}

function cmdIn(task, dir, cmd) {
    console.log(`[${task.name}] cd ${dir}; ${cmd}`)
    let args = cmd.split(/\s+/)
    let ch = child_process.spawn(args[0], args.slice(1), {
        cwd: dir,
        env: process.env,
        stdio: "inherit"
    })
    ch.on('close', (code) => {
        if (code != 0)
            task.fail();
        else task.complete();
    });
}

exports.execCallback = execCallback;
exports.expand = expand;
exports.expand1 = expand1;
exports.catFiles = catFiles;
exports.cmdIn = cmdIn;
exports.cmdsIn = cmdsIn;

