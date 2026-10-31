"""Bounded owned CLI process capture. No credentials, Cloudflare API or retry."""
import errno, os, selectors, signal, subprocess, time

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
            cleanup_failures = []
            cleanup_failure_count = 0
            settled = False

            def observe_failure(stage, error):
                nonlocal cleanup_failure_count
                cleanup_failure_count = min(255, cleanup_failure_count + 1)
                metadata = {
                    'stage': stage,
                    'errorClass': type(error).__name__ if type(error) in (
                        PermissionError, ProcessLookupError, InterruptedError,
                        OSError, RuntimeError, subprocess.TimeoutExpired,
                    ) else 'OtherError',
                    'errno': error.errno if isinstance(error, OSError) and isinstance(error.errno, int) and error.errno in errno.errorcode else None,
                }
                if metadata not in cleanup_failures and len(cleanup_failures) < 8:
                    cleanup_failures.append(metadata)

            def poll_child():
                try:
                    return child.poll() is not None
                except Exception as error:
                    observe_failure('child-poll', error)
                    return False

            def group_exists():
                try:
                    os.killpg(child.pid, 0)
                    return True
                except ProcessLookupError:
                    return False
                except Exception as error:
                    # EPERM is unknown, never evidence that the group is absent.
                    observe_failure('group-probe', error)
                    return None

            def signal_group(signum, stage):
                try:
                    os.killpg(child.pid, signum)
                except ProcessLookupError:
                    pass
                except Exception as error:
                    observe_failure(stage, error)

            def wait_group(until):
                while True:
                    reaped = poll_child()
                    present = group_exists()
                    if reaped and present is False:
                        return True
                    remaining = until - time.monotonic()
                    if remaining <= 0:
                        return False
                    time.sleep(min(0.05, remaining))

            try:
                cleanup_started = time.monotonic()
                reaped = poll_child()
                settled = group_exists() is False and reaped
                if not settled:
                    signal_group(signal.SIGTERM, 'group-term')
                    # The direct child exiting does not establish that its
                    # descendants exited. Escalate against the remaining owned
                    # group after reap; observation errors consume these same
                    # five-second TERM and five-second KILL windows.
                    settled = wait_group(cleanup_started + 5)
                    if not settled:
                        signal_group(signal.SIGKILL, 'group-kill')
                        settled = wait_group(cleanup_started + 10)
            except Exception as error:
                observe_failure('group-settlement', error)
            finally:
                # A group-probe/signal failure must not skip the independent
                # direct-child reap and stdout closure.
                reaped = poll_child()
                result['exitCode'] = child.returncode
                try:
                    if child.stdout:
                        child.stdout.close()
                except Exception as error:
                    observe_failure('stdout-close', error)
                    settled = False
                settled = settled and reaped
            if not settled:
                result['localFailure'] = True
                result['localFailureCode'] = 'owned-process-cleanup-uncertain'
                result['ownedProcessSettled'] = False
            if cleanup_failures:
                result['cleanupFailure'] = cleanup_failures[0]
                result['cleanupFailures'] = cleanup_failures
                result['cleanupFailureCount'] = cleanup_failure_count
                result['cleanupRecovered'] = settled
    return result
