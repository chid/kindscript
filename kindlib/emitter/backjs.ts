namespace ts.ks {
    export function jsEmit(bin: Binary) {
        let jssource = ""
        bin.procs.forEach(p => {
            jssource += "\n" + irToJS(bin, p) + "\n"
        })
        jssource += "\nrt.setupStringLiterals(" +
            JSON.stringify(U.mapStringMap(bin.strings, (k, v) => 1), null, 1) +
            ")\n"
        bin.writeFile("microbit.js", jssource)
    }

    export function irToJS(bin: Binary, proc: ir.Procedure) {
        let resText = ""
        let writeRaw = (s: string) => { resText += s + "\n"; }
        let write = (s: string) => { resText += "    " + s + "\n"; }
        let EK = ir.EK;

        writeRaw(`
var ${getFunctionLabel(proc.action)} ${bin.procs[0] == proc ? "= entryPoint" : ""} = function (s) {
var r0, step = s.pc;
s.pc = -1;
while (true) { switch (step) {
  case 0:
`)

        //console.log(proc.toString())
        proc.resolve()
        //console.log("OPT", proc.toString())

        proc.locals.forEach(l => {
            write(`${locref(l)} = 0;`)
        })

        if (proc.args.length) {
            write(`if (s.lambdaArgs) {`)
            proc.args.forEach((l, i) => {
                write(`  ${locref(l)} = s.lambdaArgs[${i}];`)
            })
            write(`  s.lambdaArgs = null;`)
            write(`}`)
        }


        let exprStack: ir.Expr[] = []

        let lblIdx = 0
        for (let s of proc.body) {
            if (s.stmtKind == ir.SK.Label)
                s.lblId = ++lblIdx;
        }

        for (let s of proc.body) {
            switch (s.stmtKind) {
                case ir.SK.Expr:
                    emitExpr(s.expr)
                    break;
                case ir.SK.StackEmpty:
                    for (let e of exprStack) {
                        if (e.totalUses !== e.currUses) oops();
                    }
                    exprStack = [];
                    break;
                case ir.SK.Jmp:
                    emitJmp(s);
                    break;
                case ir.SK.Label:
                    writeRaw(`  case ${s.lblId}:`)
                    break;
                default: oops();
            }
        }

        write(`return leave(s, r0)`)

        writeRaw(`  default: oops()`)
        writeRaw(`} } }`)
        writeRaw(``)

        return resText

        function locref(cell: ir.Cell) {
            if (cell.iscap)
                return `s.caps[${cell.index}]`
            return "s." + cell.uniqueName()
        }

        function emitJmp(jmp: ir.Stmt) {
            let trg = `{ step = ${jmp.lbl.lblId}; continue; }`
            if (jmp.jmpMode == ir.JmpMode.Always) {
                if (jmp.expr)
                    emitExpr(jmp.expr)
                write(trg)
            } else if (jmp.jmpMode == ir.JmpMode.IfJmpValEq) {
                write(`if (r0 == (${emitExprInto(jmp.expr)})) ${trg}`)
            } else {
                emitExpr(jmp.expr)
                if (jmp.jmpMode == ir.JmpMode.IfNotZero) {
                    write(`if (r0) ${trg}`)
                } else {
                    write(`if (!r0) ${trg}`)
                }
            }
        }

        function withRef(name: string, isRef: boolean) {
            return name + (isRef ? "Ref" : "")
        }

        function emitExprInto(e: ir.Expr): string {
            switch (e.exprKind) {
                case EK.NumberLiteral:
                    if (e.data === true) return "true"
                    else if (e.data === false) return "false"
                    else if (e.data === null) return "null"
                    else if (typeof e.data == "number") return e.data + ""
                    else throw oops();
                case EK.PointerLiteral:
                    return e.jsInfo;
                case EK.SharedRef:
                    let arg = e.args[0]
                    U.assert(!!arg.currUses) // not first use
                    U.assert(arg.currUses < arg.totalUses)
                    arg.currUses++
                    let idx = exprStack.indexOf(arg)
                    U.assert(idx >= 0)
                    return "s.tmp_" + idx
                case EK.CellRef:
                    let cell = e.data as ir.Cell;
                    if (cell.isGlobal())
                        return `${withRef("bitvm.ldglb", cell.isRef())}(${cell.index})`
                    return locref(cell)
                default: throw oops();
            }
        }

        // result in R0
        function emitExpr(e: ir.Expr): void {
            //console.log(`EMITEXPR ${e.sharingInfo()} E: ${e.toString()}`)

            switch (e.exprKind) {
                case EK.JmpValue:
                    write("// jmp value (already in r0)")
                    break;
                case EK.Incr:
                    emitExpr(e.args[0])
                    write(`bitvm.incr(r0);`)
                    break;
                case EK.Decr:
                    emitExpr(e.args[0])
                    write(`bitvm.decr(r0);`)
                    break;
                case EK.FieldAccess:
                    let info = e.data as FieldAccessInfo
                    // it does the decr itself, no mask
                    return emitExpr(ir.rtcall(withRef("bitvm::ldfld", info.isRef), [e.args[0], ir.numlit(info.idx)]))
                case EK.Store:
                    return emitStore(e.args[0], e.args[1])
                case EK.RuntimeCall:
                    return emitRtCall(e);
                case EK.ProcCall:
                    return emitProcCall(e)
                case EK.SharedDef:
                    return emitSharedDef(e)
                case EK.Sequence:
                    return e.args.forEach(emitExpr)
                default:
                    write(`r0 = ${emitExprInto(e)};`)
            }
        }

        function emitSharedDef(e: ir.Expr) {
            let arg = e.args[0]
            U.assert(arg.totalUses >= 1)
            U.assert(arg.currUses === 0)
            arg.currUses = 1
            if (arg.totalUses == 1)
                return emitExpr(arg)
            else {
                emitExpr(arg)
                let idx = exprStack.length
                exprStack.push(arg)
                write(`s.tmp_${idx} = r0;`)
            }
        }

        function emitRtCall(topExpr: ir.Expr) {
            let info = ir.flattenArgs(topExpr)

            info.precomp.forEach(emitExpr)

            let args = info.flattened.map(emitExprInto).join(", ")

            let name: string = topExpr.data
            let text = `rt.${name.replace(/::/g, ".")}(${args})`

            if (topExpr.isAsync) {
                let loc = ++lblIdx
                write(`setupResume(s, ${loc});`)
                write(`return ${text};`)
                writeRaw(`  case ${loc}:`)
                write(`checkResumeConsumed();`)
                write(`r0 = s.retval;`)
            } else {
                write(`r0 = ${text};`)
            }
        }

        function emitProcCall(topExpr: ir.Expr) {
            let frameExpr = ir.rtcall("<frame>", [])
            frameExpr.totalUses = 1
            frameExpr.currUses = 0
            let frameIdx = exprStack.length
            exprStack.push(frameExpr)

            let proc = bin.procs.filter(p => p.action == topExpr.data)[0]
            let frameRef = `s.tmp_${frameIdx}`
            let lblId = ++lblIdx
            write(`${frameRef} = { fn: ${getFunctionLabel(proc.action)}, parent: s };`)

            //console.log("PROCCALL", topExpr.toString())
            topExpr.args.forEach((a, i) => {
                emitExpr(a)
                write(`${frameRef}.${proc.args[i].uniqueName()} = r0;`)
            })

            write(`s.pc = ${lblId};`)
            write(`return actionCall(${frameRef})`)
            writeRaw(`  case ${lblId}:`)
            write(`r0 = s.retval;`)

            frameExpr.currUses = 1
        }

        function emitStore(trg: ir.Expr, src: ir.Expr) {
            switch (trg.exprKind) {
                case EK.CellRef:
                    let cell = trg.data as ir.Cell
                    if (cell.isGlobal()) {
                        emitExpr(ir.rtcall(withRef("bitvm::stglb", cell.isRef()), [src, ir.numlit(cell.index)]))
                    } else {
                        emitExpr(src)
                        write(`${locref(cell)} = r0;`)
                    }
                    break;
                case EK.FieldAccess:
                    let info = trg.data as FieldAccessInfo
                    // it does the decr itself, no mask
                    emitExpr(ir.rtcall(withRef("bitvm::stfld", info.isRef), [trg.args[0], ir.numlit(info.idx), src]))
                    break;
                default: oops();
            }
        }

    }



}
