import * as db from "./db";
import * as core from "./core";
import * as pkg from "./package";
import * as data from "./data";
import * as ws from "./workspace"

import U = ks.Util;
import Cloud = ks.Cloud;
let lf = U.lf
let allScripts: HeaderWithScript[] = [];

type Header = ws.Header;
type ScriptText = ws.ScriptText;

interface HeaderWithScript {
    id: string;
    header: Header;
    text: ScriptText;
    fsText: ScriptText;
    mtime?: number;
    textNeedsSave?: boolean;
}

function lookup(id: string) {
    return allScripts.filter(x => x.id == id)[0]
}

function getHeaders() {
    return allScripts.map(e => e.header)
}

function getHeader(id: string) {
    let e = lookup(id)
    if (e && !e.header.isDeleted)
        return e.header
    return null
}

function apiAsync(path: string, data?: any) {
    return U.requestAsync({
        url: "http://localhost:3232/api/" + path,
        method: data ? "POST" : "GET",
        data: data || undefined
    }).then(r => r.json)
}

function mergeFsPkg(pkg: ks.FsPkg) {
    let e = lookup(pkg.path)
    if (!e) {
        e = {
            id: pkg.path,
            header: null,
            text: null,
            fsText: null
        }
        allScripts.push(e)
    }

    let time = pkg.files.map(f => f.mtime)
    time.sort((a, b) => b - a)
    let modTime = Math.round(time[0] / 1000) || U.nowSeconds()
    let hd: Header = {
        name: pkg.config.name,
        meta: {},
        editor: "tsprj",
        pubId: pkg.config.installedVersion,
        pubCurrent: false,
        _rev: null,
        id: pkg.path,
        recentUse: modTime,
        modificationTime: modTime,
        blobId: null,
        blobCurrent: false,
        isDeleted: false,
    }

    if (!e.header) {
        e.header = hd
    } else {
        let eh = e.header
        eh.name = hd.name
        eh.pubId = hd.pubId
        eh.modificationTime = hd.modificationTime
        eh.isDeleted = hd.isDeleted
    }
}

function initAsync() {
    U.assert(allScripts.length == 0)
    return syncAsync();
}

function fetchTextAsync(e: HeaderWithScript): Promise<ws.ScriptText> {
    return apiAsync("pkg/" + e.id)
        .then((resp: ks.FsPkg) => {
            if (!e.text) {
                // otherwise we were beaten to it
                e.text = {};
                e.mtime = 0
                for (let f of resp.files) {
                    e.text[f.name] = f.content
                    e.mtime = Math.max(e.mtime, f.mtime)
                }
                e.fsText = U.flatClone(e.text)
            }
            return e.text
        })
}

let headerQ = new U.PromiseQueue();

function getTextAsync(id: string): Promise<ws.ScriptText> {
    let e = lookup(id)
    if (!e)
        return Promise.resolve(null as ws.ScriptText)
    if (e.text)
        return Promise.resolve(e.text)
    return headerQ.enqueue(id, () => fetchTextAsync(e))
}

function saveCoreAsync(h: ws.Header, text?: ws.ScriptText) {
    let e = lookup(h.id)

    U.assert(e.header === h)

    if (!text)
        return Promise.resolve()

    h.saveId = null
    e.textNeedsSave = true
    e.text = text

    return headerQ.enqueue<void>(h.id, () => {
        U.assert(!!e.fsText)
        let pkg: ks.FsPkg = {
            files: [],
            config: null,
            path: h.id,
        }
        for (let fn of Object.keys(e.text)) {
            if (e.text[fn] !== e.fsText[fn])
                pkg.files.push({
                    name: fn,
                    mtime: null,
                    content: e.text[fn],
                    prevContent: e.fsText[fn]
                })
        }
        let savedText = U.flatClone(e.text)
        if (pkg.files.length == 0) return Promise.resolve()
        return apiAsync("pkg/" + h.id, pkg)
            .then((pkg: ks.FsPkg) => {
                e.fsText = savedText                
                mergeFsPkg(pkg)
                data.invalidate("header:" + h.id)
                data.invalidate("header:*")
                if (text) {
                    data.invalidate("text:" + h.id)
                    h.saveId = null
                }
            })
            .catch(e => core.errorNotification(lf("Save failed!")))         
    })
}

function saveAsync(h: ws.Header, text: ws.ScriptText) {
    return saveCoreAsync(h, text)
}

function installAsync(h0: ws.InstallHeader, text: ws.ScriptText) {
    let h = <ws.Header>h0
    let path = h.name.replace(/[^a-zA-Z0-9]+/g, " ").trim().replace(/ /g, "-")
    if (lookup(path)) {
        let n = 2
        while (lookup(path + "-" + n))
            n++;
        path += "-" + n
        h.name += " " + n
    }
    h.id = path;
    h.recentUse = U.nowSeconds()
    h.modificationTime = h.recentUse;
    let e: HeaderWithScript = {
        id: h.id,
        header: h,
        text: text,
        fsText: {}
    }
    allScripts.push(e)
    return saveCoreAsync(h, text)
        .then(() => h)
}

function saveToCloudAsync(h: ws.Header) {
    return Promise.resolve()
}

function syncAsync() {
    return apiAsync("list").then((h: ks.FsPkgs) => {
        h.pkgs.forEach(mergeFsPkg)
    })
        .then(() => {
            data.invalidate("header:")
            data.invalidate("text:")
        })
}

export var provider: ws.WorkspaceProvider = {
    getHeaders,
    getHeader,
    getTextAsync,
    initAsync,
    saveAsync,
    installAsync,
    saveToCloudAsync,
    syncAsync
}