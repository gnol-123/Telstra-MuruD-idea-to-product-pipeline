"""Apply the migrations to Postgres.

    python migrations/apply.py            # apply init.sql then rls.sql
    python migrations/apply.py --dry-run  # apply, report, then roll back

Reads DBOS_DATABASE_URL from the environment or backend/.env. Both files are
written to be re-runnable, so applying twice is a no-op rather than an error.

Run from the backend/ directory.
"""

import argparse
import pathlib
import re
import sys

import psycopg
from dotenv import dotenv_values

MIGRATIONS = ["init.sql", "rls.sql"]
HERE = pathlib.Path(__file__).parent

EXPECTED_TABLES = [
    "agent_types",
    "conversations",
    "edges",
    "messages",
    "node_secrets",
    "nodes",
    "projects",
    "tool_types",
]


def database_url() -> str:
    """DBOS_DATABASE_URL from the environment, falling back to .env."""
    import os

    url = os.environ.get("DBOS_DATABASE_URL") or dotenv_values(HERE.parent / ".env").get(
        "DBOS_DATABASE_URL"
    )
    if not url:
        sys.exit(
            "DBOS_DATABASE_URL is not set.\n"
            "Put your Supabase session pooler connection string in backend/.env,\n"
            "or export it before running this script."
        )
    return url


def body(path: pathlib.Path) -> str:
    """Strip the file's own begin/commit.

    Each migration wraps itself in a transaction so it can be pasted into the
    SQL editor. Here that would commit our outer transaction and make --dry-run
    silently permanent, so we take transaction control ourselves.
    """
    sql = path.read_text(encoding="utf-8")
    sql = re.sub(r"^\s*begin\s*;", "", sql, count=1, flags=re.I | re.M)
    return re.sub(r"^\s*commit\s*;", "", sql, count=1, flags=re.I | re.M)


def report(cur) -> None:
    cur.execute(
        """
        select table_name from information_schema.tables
        where table_schema = 'public' and table_name = any(%s)
        order by table_name
        """,
        (EXPECTED_TABLES,),
    )
    found = [r[0] for r in cur.fetchall()]
    print(f"\ntables      : {len(found)}/{len(EXPECTED_TABLES)}  {found}")
    missing = sorted(set(EXPECTED_TABLES) - set(found))
    if missing:
        print(f"MISSING     : {missing}")

    cur.execute("select count(*) from pg_policies where schemaname = 'public'")
    print(f"policies    : {cur.fetchone()[0]}")

    cur.execute("select slug from public.agent_types order by sort_order")
    print(f"agent types : {[r[0] for r in cur.fetchall()]}")

    cur.execute("select slug from public.tool_types order by sort_order")
    print(f"tool types  : {[r[0] for r in cur.fetchall()]}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="apply inside a transaction, report, then roll back",
    )
    args = parser.parse_args()

    url = database_url()
    host = url.split("@")[-1].split("/")[0] if "@" in url else "?"
    print(f"target      : {host}")
    print(f"mode        : {'DRY RUN (rolls back)' if args.dry_run else 'APPLY'}\n")

    with psycopg.connect(url, connect_timeout=20, autocommit=False) as conn:
        cur = conn.cursor()
        try:
            for name in MIGRATIONS:
                path = HERE / name
                if not path.exists():
                    sys.exit(f"missing migration file: {path}")
                cur.execute(body(path))
                print(f"{name:12}: applied")

            report(cur)

            if args.dry_run:
                conn.rollback()
                print("\nDRY RUN: rolled back, database unchanged.")
            else:
                conn.commit()
                print("\nDone. Migrations applied.")
            return 0
        except psycopg.Error as exc:
            conn.rollback()
            print(f"\nFAILED: {type(exc).__name__}")
            print(exc)
            print("\nRolled back. The database is unchanged.")
            return 1


if __name__ == "__main__":
    sys.exit(main())
