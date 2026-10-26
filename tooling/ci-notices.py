"""CI run-page notices from the e2e notices file (tooling/e2e-step.sh collects it): one notice per
topic (the first two words after the project, e.g. "danmaku bench"), its lines joined, measurement
topics first. A step shows at most 10 notices; everything is also in the job summary.
  python3 tooling/ci-notices.py <file> <measurement-topic-regex>"""
import re
import sys

path, key = sys.argv[1], re.compile(sys.argv[2])
groups: dict[str, list[str]] = {}
for line in open(path, encoding='utf-8'):
    line = line.rstrip('\n')
    if not line:
        continue
    message = line.split(': ', 1)[1] if ': ' in line else line
    topic = ' '.join(re.split(r'[\s:(]+', message)[:2])
    groups.setdefault(topic, []).append(line)
order = sorted(groups, key=lambda t: (0 if key.search(t) else 1, t))
for topic in order:
    # Long topics in parts of about 4 KB (an annotation's message is cut beyond that).
    part: list[str] = []
    for line in groups[topic] + [None]:
        if line is None or (part and sum(len(l) + 3 for l in part) + len(line) > 4000):
            print(f'::notice title=e2e: {topic}::' + '%0A'.join(l.replace('%', '%25') for l in part))
            part = []
        if line is not None:
            part.append(line)
