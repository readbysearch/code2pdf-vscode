#!/bin/bash
# The demo project: a small weather tool, with a commit that adds wind speed (for Print Changes).
set -euo pipefail
P="${1:-$HOME/tiny-weather}"
rm -rf "$P" && mkdir -p "$P/src/weather" "$P/tests" && cd "$P"
git init -q -b main
git config user.name "Ada Example"; git config user.email "ada@example.com"

cat > README.md <<'EOF'
# tiny-weather

Shows the forecast for the next few days in the terminal.

    weather --city Lisbon --days 5
EOF
cat > pyproject.toml <<'EOF'
[project]
name = "tiny-weather"
version = "0.2.0"
requires-python = ">=3.10"

[project.scripts]
weather = "weather.cli:main"
EOF
cat > src/weather/__init__.py <<'EOF'
"""tiny-weather: the forecast for the next few days, in the terminal."""

__version__ = "0.2.0"
EOF
cat > src/weather/api.py <<'EOF'
"""Fetching forecasts from the Open-Meteo API (free, no key needed)."""

import json
from dataclasses import dataclass
from urllib.parse import urlencode
from urllib.request import urlopen

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"


@dataclass
class Day:
    date: str
    high: float
    low: float
    rain: float


def forecast(latitude: float, longitude: float, days: int = 3) -> list[Day]:
    """The forecast for the next DAYS days at a place."""
    query = urlencode({
        "latitude": latitude,
        "longitude": longitude,
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum",
        "forecast_days": days,
        "timezone": "auto",
    })
    with urlopen(f"{FORECAST_URL}?{query}", timeout=10) as response:
        daily = json.load(response)["daily"]
    return [
        Day(date, high, low, rain)
        for date, high, low, rain in zip(
            daily["time"],
            daily["temperature_2m_max"],
            daily["temperature_2m_min"],
            daily["precipitation_sum"],
        )
    ]
EOF
cat > src/weather/format.py <<'EOF'
"""Turning forecasts into a table for the terminal."""

from .api import Day


def describe(day: Day) -> str:
    """A word or two for the day's weather."""
    if day.rain >= 10:
        return "heavy rain"
    if day.rain > 0:
        return "showers"
    if day.high >= 30:
        return "hot"
    return "dry"


def table(days: list[Day]) -> str:
    """One line per day: date, high and low temperature, rain, and a description."""
    lines = [f"{'Date':<12}{'High':>6}{'Low':>6}{'Rain':>7}  Weather"]
    for day in days:
        lines.append(
            f"{day.date:<12}{day.high:>5.0f}°{day.low:>5.0f}°{day.rain:>5.1f}mm  {describe(day)}"
        )
    return "\n".join(lines)
EOF
cat > src/weather/cli.py <<'EOF'
"""The weather command."""

import argparse

from .api import forecast
from .format import table

CITIES = {
    "lisbon": (38.72, -9.14),
    "oslo": (59.91, 10.75),
    "tokyo": (35.68, 139.69),
}


def main() -> None:
    parser = argparse.ArgumentParser(description="The forecast for the next few days.")
    parser.add_argument("--city", default="Lisbon", help="one of: " + ", ".join(CITIES))
    parser.add_argument("--days", type=int, default=3, help="how many days (1 to 16)")
    args = parser.parse_args()
    latitude, longitude = CITIES[args.city.lower()]
    print(table(forecast(latitude, longitude, args.days)))
EOF
cat > tests/test_format.py <<'EOF'
from weather.api import Day
from weather.format import describe, table


def test_describe():
    assert describe(Day("2026-10-12", 31, 20, 0)) == "hot"
    assert describe(Day("2026-10-12", 18, 11, 12)) == "heavy rain"


def test_table_has_a_line_per_day():
    days = [Day("2026-10-12", 21, 14, 0), Day("2026-10-13", 19, 13, 2.5)]
    assert len(table(days).splitlines()) == 3
EOF
git add -A && GIT_AUTHOR_DATE="2026-10-09T10:00:00" GIT_COMMITTER_DATE="2026-10-09T10:00:00" git commit -qm "Forecast table for the next few days"

# The change to print: wind speed
python3 - <<'EOF'
import re
p = "src/weather/api.py"; s = open(p).read()
s = s.replace("    rain: float\n", "    rain: float\n    wind: float\n")
s = s.replace('"daily": "temperature_2m_max,temperature_2m_min,precipitation_sum",',
              '"daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",')
s = s.replace("        Day(date, high, low, rain)\n        for date, high, low, rain in zip(",
              "        Day(date, high, low, rain, wind)\n        for date, high, low, rain, wind in zip(")
s = s.replace('            daily["precipitation_sum"],\n', '            daily["precipitation_sum"],\n            daily["wind_speed_10m_max"],\n')
open(p, "w").write(s)
p = "src/weather/format.py"; s = open(p).read()
s = s.replace('''    if day.rain > 0:
        return "showers"''', '''    if day.rain > 0:
        return "showers"
    if day.wind >= 40:
        return "windy"''')
s = s.replace('''    """One line per day: date, high and low temperature, rain, and a description."""
    lines = [f"{'Date':<12}{'High':>6}{'Low':>6}{'Rain':>7}  Weather"]''', '''    """One line per day: date, high and low temperature, rain, wind, and a description."""
    lines = [f"{'Date':<12}{'High':>6}{'Low':>6}{'Rain':>7}{'Wind':>9}  Weather"]''')
s = s.replace('''{day.rain:>5.1f}mm  {describe(day)}"''', '''{day.rain:>5.1f}mm{day.wind:>5.0f}km/h  {describe(day)}"''')
open(p, "w").write(s)
p = "tests/test_format.py"; s = open(p).read()
s = s.replace('Day("2026-10-12", 31, 20, 0)', 'Day("2026-10-12", 31, 20, 0, 12)').replace('Day("2026-10-12", 18, 11, 12)', 'Day("2026-10-12", 18, 11, 12, 20)')
s = s.replace('Day("2026-10-12", 21, 14, 0), Day("2026-10-13", 19, 13, 2.5)', 'Day("2026-10-12", 21, 14, 0, 9), Day("2026-10-13", 19, 13, 2.5, 31)')
s += '''

def test_windy():
    assert describe(Day("2026-10-12", 17, 12, 0, 55)) == "windy"
'''
open(p, "w").write(s)
EOF
git add -A && GIT_AUTHOR_DATE="2026-10-11T16:20:00" GIT_COMMITTER_DATE="2026-10-11T16:20:00" git commit -qm "Show wind speed in the forecast"
# Not committed yet, so Print Changes also offers "Uncommitted changes"
sed -i 's/"tokyo": (35.68, 139.69),/"tokyo": (35.68, 139.69),\n    "nairobi": (-1.29, 36.82),/' src/weather/cli.py
echo "made $P"
