#!/usr/bin/env python3
"""Render PIT-61 JSON from stdin or a file, offline and read-only.

The fixed snapshot schema cannot attest review/QA, runtime completion or merge.
Unknown fields and raw strings are never rendered. Exit 2 means unavailable.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys

import snapshot as schema

STAGES = dict(zip(('backlog', 'todo', 'in_progress', 'started_2', 'started_3',
                   'in_review', 'blocked', 'done', 'cancelled'),
                  ('待排期', '待开发', '开发中', '独立审查', '独立验证',
                   '等人工验收', '阻塞', '任务标记完成', '已取消')))
CI = dict(zip(('success', 'failure', 'pending', 'missing', 'cancelled', 'skipped',
               'timed_out', 'incomplete', 'unknown'),
              ('通过', '失败', '等待中', '未运行或缺失', '已取消', '已跳过',
               '超时', '不完整', '未知')))
REASONS = {
    'not_connected': '未连接观测', 'stage_missing': '阶段缺失',
    'owner_missing': '负责人缺失', 'task_blocked': '任务阻塞',
    'observation_expired': '快照过期', 'observation_unavailable': '观测不可用',
    'pr_changed_or_unavailable': 'PR版本变化或不可用', 'branch_missing': '分支缺失',
    'version_missing': '精确版本缺失', 'ci_head_mismatch': '检查版本不匹配',
    'ci_not_successful': 'CI未通过', 'pr_not_active_on_main': 'PR未指向主线或非活动状态',
    'read_unavailable_or_invalid': '读取不可用或数据损坏',
}
ACTIONS = {'request_live_snapshot': '请由独立只读工具获取新快照',
           'resolve_observation_or_task_hold': '核实观测或任务阻塞',
           'await_human_decision': '等待人工对精确head作出决定',
           'await_serial_scheduler': '等待串行调度器核验下一门禁'}
BOUNDARIES = ('runtime completed：无法判断（格式无运行凭证）\n'
              '可合并：无法判断（还需独立审查、QA及人工精确head批准）\n'
              '工程完成：无法判断（还需批准合并与精确主线CI）\n'
              '产品接受：无法判断；部署：无法判断')


def render(data, now=None):
    """Return (Chinese text, usable observation); never infer absent gates."""
    now = now or datetime.now(timezone.utc)
    try:
        if not isinstance(data, dict) or not set(schema.FIELDS) <= data.keys():
            raise ValueError()
        if type(data['schema_version']) is not int or data['schema_version'] != 1:
            raise ValueError()
        if any(type(data[k]) is not bool for k in ('live_checked', 'passed')):
            raise ValueError()
        if data['human_decision_required'] is not None and type(data['human_decision_required']) is not bool:
            raise ValueError()
        issue = data['issue']
        if not isinstance(issue, str) or not re.fullmatch(r'PIT-[1-9][0-9]*', issue):
            raise ValueError()
        stage, ci = data['stage'], data['ci']
        if stage not in STAGES or ci not in CI:
            raise ValueError()
        reasons = data['blocked_reasons']
        if not isinstance(reasons, list) or any(not isinstance(r, str) for r in reasons):
            raise ValueError()
        stamp = datetime.fromisoformat(data['observed_at'].replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            raise ValueError()
        fresh = 0 <= (now - stamp).total_seconds() <= schema.MAX_AGE_SECONDS
        head = schema.sha(data['head'])
        pr = data['pr'] if type(data['pr']) is int and data['pr'] > 0 else None
        branch = data['branch']
        version = (head and pr and isinstance(branch, str) and re.fullmatch(
            r'codex/pit-' + issue[4:] + r'-[a-z0-9-]+', branch))
        usable = bool(fresh and data['live_checked'] and version and schema.identity(data['owner'])
                      and not any(r != 'ci_not_successful' and r != 'task_blocked' for r in reasons))
        if data['passed'] != (not reasons and ci == 'success'):
            usable = False
        lines = [f'{issue} · {STAGES[stage]}',
                 f'精确版本：PR #{pr} / {head}' if version else '精确版本：无法判断',
                 f'检查：CI {CI[ci]}' if usable else '检查：无法判断（快照缺失、损坏、过期或不完整）']
        blocks = [REASONS.get(r, '未知阻塞（原文已隐藏）') for r in reasons]
        if not fresh:
            blocks.append('快照过期或时间异常')
        if not usable:
            blocks.append('观测无法判断')
        lines.append('阻塞：' + ('；'.join(blocks) if blocks else '未观测到CI阻塞；其他门禁仍需核验'))
        action = ACTIONS.get(data['next_action'], '核实快照格式与门禁') if usable else ACTIONS['request_live_snapshot']
        lines.extend(['下一动作：' + action, BOUNDARIES])
        return '\n'.join(lines), usable
    except (ValueError, TypeError, KeyError, AttributeError):
        return ('状态/检查：无法判断（快照缺失、损坏或不完整）\n'
                '阻塞：输入不可用\n下一动作：请由独立只读工具获取新快照\n' + BOUNDARIES), False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', nargs='?', help='JSON文件；省略时读取标准输入')
    args = parser.parse_args()
    try:
        data = json.loads(Path(args.file).read_text(encoding='utf-8') if args.file else sys.stdin.read())
    except (OSError, UnicodeError, ValueError):
        data = None
    output, usable = render(data)
    print(output)
    return 0 if usable else 2


if __name__ == '__main__':
    raise SystemExit(main())
