"""
Structured Logging Module with Rich Console Output and Rotating File Handlers.
"""

import sys
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from rich.logging import RichHandler
from rich.console import Console

from src.config import LOGS_DIR

# Force UTF-8 encoding on Windows console if supported
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

console = Console(force_terminal=True, soft_wrap=True)


def setup_logger(name: str = "vtiger_ghl", level: int = logging.INFO) -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.hasHandlers():
        return logger

    logger.setLevel(level)

    # Rich Console Handler
    rich_handler = RichHandler(
        console=console,
        rich_tracebacks=True,
        markup=True,
        show_time=True,
        show_path=False
    )
    rich_handler.setLevel(level)
    logger.addHandler(rich_handler)

    # Rotating File Handler (Max 10MB, 5 backups)
    log_file = LOGS_DIR / "integration_system.log"
    file_handler = RotatingFileHandler(
        filename=log_file,
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8"
    )
    file_formatter = logging.Formatter(
        "[%(asctime)s] [%(levelname)s] [%(name)s:%(funcName)s:%(lineno)d] - %(message)s"
    )
    file_handler.setFormatter(file_formatter)
    file_handler.setLevel(logging.DEBUG)
    logger.addHandler(file_handler)

    return logger


logger = setup_logger()
