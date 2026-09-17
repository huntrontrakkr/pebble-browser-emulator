# SPDX-License-Identifier: Apache-2.0
from pathlib import Path

Path("generated.c").write_text("int generated(void) { return 42; }\n")
