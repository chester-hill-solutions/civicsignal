"""Bounded owned CLI process capture. No credentials, Cloudflare API or retry."""
import os, selectors, signal, subprocess, time

def capture_owned(argv, cwd, env, log, timeout=180, max_bytes=2097152, write_chunk=None):
    result = {'exitCode': None, 'timedOut': False, 'logBoundExceeded': False, 'localFailure': False,
              'localFailureCode': None, 'maxLogBytes': max_bytes, 'childPid': None, 'ownedProcessSettled': True}
    child = None
    try:
        with log.open('xb') as stream:
            os.chmod(log, 0o600)
            child = subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            result['childPid'] = child.pid
            deadline = time.monotonic() + timeout
            written = 0
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                while selector.get_map():
                    remaining_time = deadline - time.monotonic()
                    if remaining_time <= 0:
                        raise subprocess.TimeoutExpired(child.args, timeout)
                    for key, _ in selector.select(min(0.25, remaining_time)):
                        data = os.read(key.fd, 65536)
                        if not data:
                            selector.unregister(key.fileobj)
                            continue
                        remaining = max_bytes - written
                        block = data[:remaining]
                        if write_chunk:
                            write_chunk(stream, block)
                        else:
                            stream.write(block)
                        written += len(block)
                        if len(data) > remaining:
                            result['logBoundExceeded'] = True
                            raise subprocess.TimeoutExpired(child.args, timeout)
            result['exitCode'] = child.wait(timeout=max(0.01, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        result['timedOut'] = True
    except Exception:
        # Do not stringify exceptions containing paths, environment or output.
        result['localFailure'] = True
        result['localFailureCode'] = 'owned-process-or-local-io-failure'
    finally:
        # Any failure after spawn must settle this owned process group. Never
        # leave a new-session Wrangler child outside the finite monitor.
        if child is not None:
            try:
                def group_exists():
                    try:
                        os.killpg(child.pid, 0)
                        return True
                    except ProcessLookupError:
                        return False

                def wait_group(seconds):
                    until = time.monotonic() + seconds
                    while True:
                        child.poll()  # Reap the direct child before checking.
                        if not group_exists():
                            return True
                        if time.monotonic() >= until:
                            return False
                        time.sleep(min(0.05, max(0, until - time.monotonic())))

                if child.poll() is None or result['timedOut'] or result['localFailure'] or result['logBoundExceeded'] or group_exists():
                    try:
                        os.killpg(child.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    # The direct child exiting does not establish that its
                    # descendants exited. Escalate against the remaining owned
                    # process group even after the direct child was reaped.
                    if not wait_group(5):
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        if not wait_group(5):
                            raise RuntimeError('owned-process-group-not-settled')
                result['exitCode'] = child.returncode
                if child.stdout:
                    child.stdout.close()
            except Exception:
                result['localFailure'] = True
                result['localFailureCode'] = 'owned-process-cleanup-uncertain'
                result['ownedProcessSettled'] = False
    return result
