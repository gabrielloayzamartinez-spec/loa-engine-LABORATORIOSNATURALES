"""
Entry point for Vitrail ↔ GoHighLevel (GHL) Enterprise Integration Suite.
"""

import sys
import os

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# Add root directory to python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from src.cli.menu import main

if __name__ == "__main__":
    main()
