/*
 * One external command at a time, and a way to stop the one that is running.
 *
 * Nothing here knows what it is running. It takes a runner, accepts jobs, keeps
 * exactly one of them talking to the world, and lets go of the rest when the
 * thing they were for has gone - which is the whole of the scheduling this
 * applet needs and none of the subject it was written for.
 *
 * It lived in lib/ddc.js, which meant a queue with no monitor in it could only
 * be reached through a file about monitors. The log lines still name ddcutil,
 * because that is what the caller passes it and what a reader of the log needs
 * to be told about.
 */

const Log = require("./lib/log.js");

/*
 * One external command at a time, with writes ahead of everything else.
 *
 * Nothing here knows what ddcutil is. It takes a runner, accepts jobs, keeps
 * exactly one of them talking to the world, and answers `busy` for as long as
 * anything is accepted but unfinished - which is the single ownership
 * invariant a caller needs in order to know that no independent path is using
 * the transport.
 *
 * Writes are inserted before the reads and probes already waiting, preserving
 * order within each class: a drag on a slider must not sit behind a
 * whole-machine probe that will take seconds, and a read taken because of a
 * write must not overtake the write that caused it.
 *
 * A job answers exactly once. A runner that throws, a runner that calls back
 * twice, a cancelled job and one handed to a queue that has already been
 * destroyed all arrive at the caller as one settled answer, because a caller
 * counting outstanding work cannot survive either a missing reply or a second
 * one.
 */
const CommandQueue = class CommandQueue {
    /* `run(argv, onDone)` may answer with a handle carrying cancel(); an
     * injected runner need not, so it stays optional. `onIdle` is called after
     * every completed job, once the queue has had its chance to start the
     * next. */
    constructor(run, onIdle) {
        this._run = run;
        this._onIdle = onIdle || function () {};
        /* The count includes the active job and everything queued. */
        this._inFlight = 0;
        this._active = null;
        /* What the transport gave back for the active job, when it gave
         * anything: the handle cancelActive() ends a running command with. */
        this._activeCancel = null;
        this._queue = [];
        this._destroyed = false;
    }

    get busy() {
        return this._inFlight > 0;
    }

    run(argv, onDone, kind) {
        let job = { argv: argv, onDone: onDone, kind: kind || "read" };
        /* A stopped queue dispatches nothing, so a job taken onto it is a job
         * that is never answered and an in-flight count that never comes back
         * down - and `busy` is the one ownership invariant callers read. It is
         * answered here the same way cancelQueued answers the jobs that were
         * already waiting when destroy() arrived: as the failure the command
         * that will not run amounts to. */
        if (this._destroyed) {
            this._settle(job);
            return;
        }
        this._inFlight++;
        if (job.kind === "write") {
            let before = this._queue.findIndex(queued => queued.kind !== "write");
            if (before < 0)
                this._queue.push(job);
            else
                this._queue.splice(before, 0, job);
        } else {
            this._queue.push(job);
        }
        this._drain();
    }

    _drain() {
        if (this._destroyed || this._active || this._queue.length === 0)
            return;
        let job = this._queue.shift();
        this._active = job;
        let answered = false;
        let finish = (output, status) => {
            if (answered)
                return;
            answered = true;
            try {
                job.onDone(output, status);
            } finally {
                this._activeCancel = null;
                this._active = null;
                this._inFlight--;
                this._drain();
                this._onIdle();
            }
        };
        try {
            this._activeCancel = this._run(job.argv, finish) || null;
        } catch (error) {
            Log.error("could not run ddcutil: " + error);
            finish("", -1);
        }
    }

    /* End the command that is already talking to the world. The transport
     * settles it as a failure, which returns it through _drain's finish and so
     * keeps the in-flight count and the queue honest. */
    cancelActive() {
        let handle = this._activeCancel;
        this._activeCancel = null;
        if (!handle || typeof handle.cancel !== "function")
            return;
        try {
            handle.cancel();
        } catch (error) {
            Log.error("could not stop the running ddcutil: " + error);
        }
    }

    /* Nothing waiting has reached the transport, so each is answered as a
     * failure without anything being cancelled. */
    cancelQueued() {
        let queued = this._queue.splice(0);
        for (let job of queued) {
            this._inFlight--;
            this._settle(job);
        }
    }

    /* One answer for a job that never reached the transport. A caller that
     * throws is reported rather than propagated: it must not stop the rest of
     * the queue being settled, nor escape into a Gio callback. */
    _settle(job) {
        try {
            job.onDone("", -1);
        } catch (error) {
            Log.error("could not settle cancelled ddcutil work: " + error);
        }
    }

    destroy() {
        this._destroyed = true;
        this.cancelQueued();
        this.cancelActive();
    }
};
