# -*- coding: utf-8 -*-
"""查 SRC 库 endpoint 表：按 host 模糊匹配统计/列明细。
用法:
  python query_srcdb.py volcengine.com          # 统计 + 最近 10 条
  python query_srcdb.py volcengine.com --all    # 全部明细
  python query_srcdb.py volcengine.com --count  # 只出计数（唯一接口口径）
"""
import sys

import psycopg

DSN = "host=127.0.0.1 port=15432 dbname=src user=src"


def main():
    host_like = sys.argv[1] if len(sys.argv) > 1 else "volcengine.com"
    flag = sys.argv[2] if len(sys.argv) > 2 else ""
    pat = f"%{host_like}%"
    conn = psycopg.connect(DSN)
    cur = conn.cursor()

    # 唯一接口数（去重键即表唯一键 host+method+path+kind，行数即唯一数）
    cur.execute(
        "SELECT kind, count(*) FROM endpoint WHERE host LIKE %s GROUP BY kind ORDER BY kind",
        (pat,),
    )
    rows = cur.fetchall()
    total = sum(n for _, n in rows)
    print(f"== endpoint 唯一接口数（host LIKE {pat}）==")
    for kind, n in rows:
        print(f"  {kind}: {n}")
    print(f"  合计: {total}")
    if flag == "--count":
        return

    limit = "ALL" if flag == "--all" else 10
    cur.execute(
        """SELECT host, method, path, kind, project, response_status, captured_at
           FROM endpoint WHERE host LIKE %s ORDER BY id DESC LIMIT %s""",
        (pat, 10 if flag != "--all" else 100000),
    )
    print(f"\n== 最近明细（limit {limit}）==")
    for host, method, path, kind, project, status, ts in cur.fetchall():
        print(f"  [{kind}] {method} {host}{path} -> {status}  ({project})  {ts:%m-%d %H:%M}")


if __name__ == "__main__":
    main()
