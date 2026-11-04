import contextlib
import os
import subprocess


@contextlib.contextmanager
def instance_lock(db_path):
    """One daemon per database. OS releases the byte lock after a crash."""
    path = os.path.abspath(db_path) + '.lock'
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'a+b') as f:
        if not f.seek(0, os.SEEK_END):
            f.write(b'0')
            f.flush()
        f.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise RuntimeError('dispatcher already running for ' + os.path.abspath(db_path)) from None
        try:
            yield
        finally:
            f.seek(0)
            if os.name == 'nt':
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def terminate(p):
    if p.poll() is None:
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(p.pid), '/T', '/F'], capture_output=True, timeout=15)
        else:
            p.terminate()
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait(timeout=5)
    if p.stdout:
        p.stdout.close()
