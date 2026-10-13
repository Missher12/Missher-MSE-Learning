"""A transparent Node clock override for tests that must cross the core's real 30-minute cooldown.

The shipped core refuses a new reflection for 30 real minutes after the last one (`cooldownUntil`),
and that refusal is a product fact, not a test nuisance: it must not be relaxed, and neither the
daily allowance nor a spend record may be seeded to walk around it. What a test may move is the clock
the core READS. This preload is loaded through `NODE_OPTIONS --import`, so the shipped `src/cli.mjs`,
its limits, its gate and its learning-state files are all exactly the product's — only the wall clock
the fixture feeds them is advanced, by the test, explicitly.

The file is a plain ES module so Node's own loader reads it; nothing about the core, the process
environment of the driver, or the state root is patched.
"""
import os
from pathlib import Path
import shutil
import tempfile
import time

PRELOAD = ("import {readFileSync} from 'node:fs';\n"
           "const readClock = () => Number(readFileSync(process.env.MSE_AUDIT_CLOCK_FILE, 'utf8'));\n"
           "Date.now = readClock;\n")


class NodeClock:
    """One clock file plus the `NODE_OPTIONS` preload that makes every Node child read it."""

    def __init__(self, test):
        self.directory = Path(tempfile.mkdtemp(prefix="mse-node-clock-"))
        test.addCleanup(shutil.rmtree, self.directory, True)
        preload = self.directory / "node-clock-fixture.mjs"
        preload.write_text(PRELOAD)
        self.file = self.directory / "clock-ms"
        self.file.write_text(str(int(time.time() * 1000)))
        self.previous_options = os.environ.get("NODE_OPTIONS")
        self.previous_file = os.environ.get("MSE_AUDIT_CLOCK_FILE")
        os.environ["NODE_OPTIONS"] = "--import=%s" % preload
        os.environ["MSE_AUDIT_CLOCK_FILE"] = str(self.file)
        test.addCleanup(self.restore)

    def now_ms(self):
        return int(self.file.read_text().strip())

    def advance_ms(self, milliseconds):
        """Move the clock the CORE reads forward, and return the new value."""
        value = self.now_ms() + int(milliseconds)
        pending = self.file.with_suffix(".next")
        pending.write_text(str(value))
        pending.replace(self.file)
        return value

    def restore(self):
        if self.previous_options is None:
            os.environ.pop("NODE_OPTIONS", None)
        else:
            os.environ["NODE_OPTIONS"] = self.previous_options
        if self.previous_file is None:
            os.environ.pop("MSE_AUDIT_CLOCK_FILE", None)
        else:
            os.environ["MSE_AUDIT_CLOCK_FILE"] = self.previous_file
