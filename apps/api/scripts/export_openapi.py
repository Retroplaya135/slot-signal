import argparse
import json
from pathlib import Path

from app.main import create_app


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export the API OpenAPI schema.")
    parser.add_argument(
        "--output",
        type=Path,
        help="Optional path to write the schema. Prints to stdout when omitted.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    schema_json = json.dumps(create_app().openapi(), indent=2, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(schema_json + "\n", encoding="utf-8")
        return
    print(schema_json)


if __name__ == "__main__":
    main()

