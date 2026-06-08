#!/usr/bin/env python3
"""
StoryTelling — Headless Playthrough Test + Prompt Analysis

Plays through a configured set of turns against the backend API,
then analyzes the outputs to surface prompt fine-tuning suggestions.

Run via:  podman compose run --rm tester
Or with a custom config:  python tests/test_playthrough.py tests/my_config.json
"""

import datetime
import json
import math
import os
import re
import sys
import uuid
from collections import defaultdict
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERROR: 'requests' not installed. Run: pip install requests")
    sys.exit(1)


PROJECT_ROOT = Path(__file__).parent.parent


# ── Data ───────────────────────────────────────────────────────────────────────

class TurnStreamResult:
    __slots__ = ("response_text", "prompt_tokens", "completion_tokens",
                 "total_tokens", "duration_ms", "turn_id")

    def __init__(self, response_text, prompt_tokens, completion_tokens,
                 total_tokens, duration_ms, turn_id):
        self.response_text = response_text
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens
        self.total_tokens = total_tokens
        self.duration_ms = duration_ms
        self.turn_id = turn_id


class TurnRecord:
    __slots__ = ("turn_index", "action_type", "raw_input", "player_line",
                 "response", "prompt_tokens", "completion_tokens",
                 "total_tokens", "duration_ms", "turn_id", "error")

    def __init__(self, turn_index, action_type, raw_input, player_line,
                 result=None, error=None):
        self.turn_index = turn_index
        self.action_type = action_type
        self.raw_input = raw_input
        self.player_line = player_line
        self.response = result.response_text if result else ""
        self.prompt_tokens = result.prompt_tokens if result else 0
        self.completion_tokens = result.completion_tokens if result else 0
        self.total_tokens = result.total_tokens if result else 0
        self.duration_ms = result.duration_ms if result else 0
        self.turn_id = result.turn_id if result else None
        self.error = error


# ── DungeonConfig ──────────────────────────────────────────────────────────────

class DungeonConfig:
    """Loads config.json + scenarios/<id>.json and exposes the pieces MessageBuilder needs."""

    VALID_CARD_TYPES = {"location", "npc", "item", "faction", "lore"}

    def __init__(self, config_path, scenario_id):
        config_path = Path(config_path)
        with open(config_path, encoding="utf-8") as f:
            data = json.load(f)
        self.system_prompt        = data.get("systemPrompt", "")
        self.custom_prompt        = data.get("customSystemPrompt", "")
        self.context_max_messages = data.get("contextMaxMessages", 15)
        self.action_prompts       = data.get("actionPrompts", {})
        self.generation           = data.get("generation", {})

        # Load scenario from scenarios/<id>.json (project root / scenarios/)
        scenarios_dir = config_path.parent / "scenarios"
        scenario_file = scenarios_dir / f"{scenario_id}.json"
        if not scenario_file.exists():
            raise FileNotFoundError(
                f"Scenario file not found: {scenario_file}\n"
                f"Available: {[p.stem for p in scenarios_dir.glob('*.json') if p.stem != 'index' and p.stem != 'schema']}"
            )
        with open(scenario_file, encoding="utf-8") as f:
            scenario = json.load(f)
        self._validate_scenario(scenario, scenario_file.name)
        self.scenario = scenario

    @classmethod
    def _validate_scenario(cls, sc, filename):
        errors = []
        if not sc.get("id"):
            errors.append('missing "id"')
        if not sc.get("name"):
            errors.append('missing "name"')
        expected_id = Path(filename).stem
        if sc.get("id") and sc["id"] != expected_id:
            errors.append(f'"id" ("{sc["id"]}") does not match filename ("{filename}")')
        for i, card in enumerate(sc.get("cards", [])):
            if not card.get("type"):
                errors.append(f"card[{i}] missing \"type\"")
            elif card["type"] not in cls.VALID_CARD_TYPES:
                errors.append(f"card[{i}] invalid type \"{card['type']}\"")
            if not card.get("name"):
                errors.append(f"card[{i}] missing \"name\"")
        if errors:
            raise ValueError(f"Scenario \"{filename}\" validation failed: {'; '.join(errors)}")

    def build_character_context(self):
        chars = self.scenario.get("mainCharacters", [])
        if not chars:
            return ""
        c = chars[0]
        parts = [p for p in [c.get("name"), c.get("description")] if p]
        if c.get("class"):
            parts.append(f"Class: {c['class']}")
        if c.get("notes"):
            parts.append(f"Notes: {c['notes']}")
        return f"The protagonist is {' — '.join(parts)}." if parts else ""


# ── MessageBuilder ─────────────────────────────────────────────────────────────

class MessageBuilder:
    """
    Stateful replica of buildMessages() from game.js.
    Maintains a rolling message history and assembles the full prompt for each turn.
    """

    def __init__(self, dc: DungeonConfig):
        self.dc = dc
        self.messages = []
        self.story_summary = ""

    @staticmethod
    def build_player_action_text(text, action_type):
        if action_type == "say":
            return f'> You say: "{text}"\n'
        if action_type == "story":
            return f'[{text}]\n'
        return f'> You {text}\n'

    def build_cards_context(self, player_line=""):
        cards = self.dc.scenario.get("cards", [])
        if not cards:
            return ""

        search_text = " ".join(
            [player_line] + [m["content"] for m in self.messages[-2:]]
        ).lower()

        relevant = []
        for c in cards:
            triggers = c.get("triggers", "") or ""
            keywords = [t.strip().lower() for t in triggers.split(",") if t.strip()]
            if not keywords or any(k in search_text for k in keywords):
                relevant.append(c)

        if not relevant:
            return ""

        lines = []
        for c in relevant:
            ctype = c.get("type", "").upper()
            name = c.get("name", "")
            desc = c.get("description", "")
            lines.append(f"[{ctype}] {name}" + (f": {desc}" if desc else ""))
        return "World context:\n" + "\n".join(lines)

    def build_messages(self, action_type, player_line=None):
        """Mirrors game.js buildMessages() exactly."""
        char_ctx = self.dc.build_character_context()
        action_prompt = (
            "" if action_type == "continue"
            else self.dc.action_prompts.get(action_type, "")
        )
        cards_ctx = self.build_cards_context(player_line or "")

        sys_parts = [
            self.dc.system_prompt,
            self.dc.scenario.get("scenarioPrompt", ""),
            self.dc.custom_prompt,
            char_ctx,
            cards_ctx,
            f"Story so far: {self.story_summary}" if self.story_summary else "",
            action_prompt,
        ]
        sys_content = "\n\n".join(p for p in sys_parts if p)

        history = list(self.messages)
        # Opening text is the first assistant message — move it into sysContent
        if history and history[0]["role"] == "assistant":
            sys_content += "\n\nStory opening: " + history[0]["content"]
            history = history[1:]

        msgs = [{"role": "system", "content": sys_content}] + history
        if player_line:
            msgs.append({"role": "user", "content": player_line})
        return msgs

    def record_player_action(self, player_line):
        self.messages.append({"role": "user", "content": player_line})

    def record_assistant_response(self, response_text, context_max_messages):
        """Push assistant message, trim to window, return overflow for summarization."""
        self.messages.append({"role": "assistant", "content": response_text})
        overflow = None
        if len(self.messages) > context_max_messages:
            cut = len(self.messages) - context_max_messages
            overflow = list(self.messages[:cut])
            self.messages = self.messages[-context_max_messages:]
        return overflow


# ── GameClient ─────────────────────────────────────────────────────────────────

class GameClient:
    """Thin requests wrapper for the StoryTelling backend API."""

    def __init__(self, base_url):
        self.base_url = base_url.rstrip("/")

    def health_check(self):
        r = requests.get(f"{self.base_url}/api/health", timeout=5)
        r.raise_for_status()
        return r.json()

    def create_game(self, payload):
        r = requests.post(f"{self.base_url}/api/games", json=payload, timeout=10)
        r.raise_for_status()
        return r.json()

    def get_game(self, game_id):
        r = requests.get(f"{self.base_url}/api/games/{game_id}", timeout=10)
        r.raise_for_status()
        return r.json()

    def summarize_game(self, game_id, messages, existing_summary=""):
        r = requests.post(
            f"{self.base_url}/api/games/{game_id}/summarize",
            json={"messages": messages, "existing_summary": existing_summary},
            timeout=60,
        )
        r.raise_for_status()
        return r.json()

    def stream_turn(self, game_id, payload, on_token=None):
        """Stream a turn, calling on_token(content) for each token chunk."""
        response_text = ""
        prompt_tokens = completion_tokens = total_tokens = duration_ms = 0
        turn_id = None

        r = requests.post(
            f"{self.base_url}/api/games/{game_id}/turns",
            json=payload,
            stream=True,
            timeout=(10, 90),
        )
        r.raise_for_status()

        for line in r.iter_lines(decode_unicode=True):
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            t = event.get("type")
            if t == "token":
                content = event.get("content", "")
                response_text += content
                if on_token:
                    on_token(content)
            elif t == "done":
                prompt_tokens = event.get("prompt_tokens", 0)
                completion_tokens = event.get("completion_tokens", 0)
                total_tokens = event.get("total_tokens", 0)
                duration_ms = event.get("duration_ms", 0)
                turn_id = event.get("turn_id")
            elif t == "error":
                raise RuntimeError(event.get("content", "Unknown stream error"))

        return TurnStreamResult(
            response_text, prompt_tokens, completion_tokens,
            total_tokens, duration_ms, turn_id
        )


# ── PlaythroughRunner ──────────────────────────────────────────────────────────

class PlaythroughRunner:
    """Orchestrates the turn loop, streaming each action to the backend."""

    def __init__(self, config):
        self.config = config
        self.dc = DungeonConfig(
            PROJECT_ROOT / config["dungeon_config_path"],
            config["scenario_id"],
        )
        self.client = GameClient(config["base_url"])
        self.mb = MessageBuilder(self.dc)
        self.game_id = None
        self.context_max = self.dc.context_max_messages

    def run(self):
        print("Checking backend health...")
        try:
            health = self.client.health_check()
        except Exception as e:
            print(f"ERROR: Cannot reach backend at {self.config['base_url']}: {e}")
            sys.exit(1)

        issues = [k for k, v in health.items() if v != "ok"]
        if issues:
            print(f"ERROR: Services not healthy: {health}")
            sys.exit(1)
        print(f"  Ollama: OK | DB: OK")

        opening_text = self.dc.scenario.get("openingText", "")
        run_hash = uuid.uuid4().hex[:6]
        game_title = f"{self.config['game_title']} #{run_hash}"
        game = self.client.create_game({
            "title": game_title,
            "scenario_id": self.config["scenario_id"],
            "model_id": self.config["model_id"],
            "system_prompt": self.dc.system_prompt,
            "scenario_prompt": self.dc.scenario.get("scenarioPrompt", ""),
            "custom_prompt": self.dc.custom_prompt,
            "opening_text": opening_text,
        })
        self.game_id = game["id"]
        print(f"  Game created: id={self.game_id}  \"{game_title}\"")

        # Seed opening text as first assistant message (mirrors loadGame() in game.js)
        self.mb.record_assistant_response(opening_text, self.context_max)

        actions = self.config["actions"]
        gen = self.config["generation"]
        records = []

        print(f"\n{'='*60}")
        print(f"  {len(actions)} turns | model: {self.config['model_id']}")
        print(f"{'='*60}\n")

        for i, action in enumerate(actions):
            action_type = action["type"]
            raw_input = action["text"]

            print(f"Turn {i+1}/{len(actions)} [{action_type}]  \"{raw_input[:60]}\"")

            player_line = MessageBuilder.build_player_action_text(raw_input, action_type)
            messages = self.mb.build_messages(action_type, player_line)

            payload = {
                "action_type": action_type,
                "raw_input": raw_input,
                "messages": messages,
                "model_id": self.config["model_id"],
                "temperature": gen.get("temperature", 0.75),
                "num_predict": gen.get("num_predict", 150),
                "repeat_penalty": gen.get("repeat_penalty", 1.1),
                "num_ctx": gen.get("num_ctx", 4096),
            }

            token_count = [0]

            def on_token(content, tc=token_count):
                tc[0] += 1
                print(f"\r  Generating... {tc[0]} tokens", end="", flush=True)

            try:
                result = self.client.stream_turn(self.game_id, payload, on_token=on_token)
                print()  # end the \r line

                tps = result.completion_tokens * 1000 / max(result.duration_ms, 1)
                print(f"  OK  {result.completion_tokens} tokens | {result.duration_ms}ms | {tps:.1f} tok/s")
                preview = result.response_text[:80].replace("\n", " ")
                print(f"  >> {preview}...")

                self.mb.record_player_action(player_line)
                overflow = self.mb.record_assistant_response(result.response_text, self.context_max)

                if overflow:
                    try:
                        sr = self.client.summarize_game(
                            self.game_id, overflow, self.mb.story_summary
                        )
                        self.mb.story_summary = sr.get("summary", "")
                        print(f"  [context summarized: {len(overflow)} messages condensed]")
                    except Exception as e:
                        print(f"  [summary failed: {e}]")

                records.append(TurnRecord(i + 1, action_type, raw_input, player_line, result=result))

            except Exception as e:
                print()
                print(f"  ERROR: {e}")
                records.append(TurnRecord(i + 1, action_type, raw_input, player_line, error=str(e)))

        succeeded = sum(1 for r in records if r.error is None)
        print(f"\n{'='*60}")
        print(f"  Playthrough complete: {succeeded}/{len(actions)} turns succeeded")
        print(f"  Game ID: {self.game_id}")
        print(f"{'='*60}\n")

        return records


# ── Analyzer ───────────────────────────────────────────────────────────────────

class Analyzer:
    """Computes 7 metric groups from completed turn records."""

    def __init__(self, records, config):
        self.records = [r for r in records if r.error is None]
        self.all_records = records
        self.config = config
        self.num_predict = config["generation"].get("num_predict", 150)

    def analyze_response_lengths(self):
        tokens = [r.completion_tokens for r in self.records]
        if not tokens:
            return {}
        tokens_sorted = sorted(tokens)
        avg = sum(tokens) / len(tokens)
        median = tokens_sorted[len(tokens_sorted) // 2]
        short = [
            {"index": r.turn_index, "tokens": r.completion_tokens}
            for r in self.records if r.completion_tokens < 30
        ]
        truncated = [
            {"index": r.turn_index, "tokens": r.completion_tokens}
            for r in self.records if r.completion_tokens >= self.num_predict * 0.95
        ]
        min_rec = min(self.records, key=lambda r: r.completion_tokens)
        max_rec = max(self.records, key=lambda r: r.completion_tokens)
        return {
            "avg": round(avg, 1),
            "median": median,
            "min": min(tokens),
            "max": max(tokens),
            "min_turn": min_rec.turn_index,
            "max_turn": max_rec.turn_index,
            "short_turns": short,
            "truncated_turns": truncated,
        }

    def analyze_generation_speed(self):
        speeds = [
            (r.turn_index, r.completion_tokens * 1000 / max(r.duration_ms, 1), r.duration_ms)
            for r in self.records
        ]
        if not speeds:
            return {}
        avg_tps = sum(s[1] for s in speeds) / len(speeds)
        fastest = max(speeds, key=lambda s: s[1])
        slowest = min(speeds, key=lambda s: s[1])
        return {
            "avg_tps": round(avg_tps, 2),
            "min_tps": round(slowest[1], 2),
            "max_tps": round(fastest[1], 2),
            "fastest_turn": {"index": fastest[0], "tps": round(fastest[1], 2), "duration_ms": fastest[2]},
            "slowest_turn": {"index": slowest[0], "tps": round(slowest[1], 2), "duration_ms": slowest[2]},
            "by_turn": [{"index": s[0], "tps": round(s[1], 2)} for s in speeds],
        }

    def analyze_prompt_growth(self):
        data = [(r.turn_index, r.prompt_tokens) for r in self.records]
        if not data:
            return {}
        n = len(data)
        xs = [d[0] for d in data]
        ys = [d[1] for d in data]
        # Ordinary least-squares slope (no external deps)
        slope = 0.0
        if n > 1:
            sx = sum(xs); sy = sum(ys)
            sxy = sum(x * y for x, y in zip(xs, ys))
            sx2 = sum(x * x for x in xs)
            denom = n * sx2 - sx ** 2
            if denom:
                slope = (n * sxy - sx * sy) / denom

        num_ctx = self.config["generation"].get("num_ctx", 4096)
        warn_threshold = num_ctx * 0.8
        projected_overflow = None
        if slope > 0 and ys[-1] < warn_threshold:
            projected_overflow = round(xs[-1] + (warn_threshold - ys[-1]) / slope)

        # Sample at turn 1, then every 5 turns
        sampled = [{"turn": d[0], "prompt_tokens": d[1]}
                   for d in data if d[0] == 1 or d[0] % 5 == 0]

        return {
            "first_tokens": ys[0],
            "last_tokens": ys[-1],
            "total_growth": ys[-1] - ys[0],
            "growth_rate": round(slope, 1),
            "projected_overflow_turn": projected_overflow,
            "num_ctx": num_ctx,
            "sampled": sampled,
        }

    @staticmethod
    def _trigrams(text):
        words = re.findall(r"\w+", text.lower())
        return [tuple(words[i:i + 3]) for i in range(len(words) - 2)]

    def analyze_repetition(self):
        flagged = []
        overlaps = []
        for i in range(len(self.records) - 1):
            r1, r2 = self.records[i], self.records[i + 1]
            t1 = set(self._trigrams(r1.response))
            t2 = set(self._trigrams(r2.response))
            if not t1 or not t2:
                continue
            ratio = len(t1 & t2) / max(len(t1), len(t2))
            overlaps.append(ratio)
            if ratio > 0.40:
                flagged.append({
                    "turns": (r1.turn_index, r2.turn_index),
                    "overlap_ratio": round(ratio, 3),
                })
        avg_overlap = round(sum(overlaps) / len(overlaps), 3) if overlaps else 0
        max_overlap = round(max(overlaps), 3) if overlaps else 0
        return {"flagged_pairs": flagged, "avg_overlap": avg_overlap, "max_overlap": max_overlap}

    def analyze_action_responsiveness(self):
        by_type = defaultdict(list)
        for r in self.records:
            by_type[r.action_type].append(r.completion_tokens)
        return {
            atype: {
                "count": len(tokens),
                "avg_tokens": round(sum(tokens) / len(tokens), 1),
                "min_tokens": min(tokens),
                "max_tokens": max(tokens),
            }
            for atype, tokens in by_type.items()
        }

    def analyze_format_compliance(self):
        issues = defaultdict(list)
        for r in self.records:
            text = r.response.strip()
            if text and text[0].islower():
                issues["starts_mid_sentence"].append(r.turn_index)
            if text.endswith("..."):
                issues["ends_with_ellipsis"].append(r.turn_index)
            if re.search(r"\[.*?\]", text):
                issues["contains_ooc_brackets"].append(r.turn_index)
            if re.search(r"i'm sorry|i apologize|as an ai", text, re.IGNORECASE):
                issues["contains_apology"].append(r.turn_index)
        return dict(issues)

    def generate_recommendations(self, lengths, speed, growth, repetition,
                                  responsiveness, compliance):
        recs = []
        np_ = self.num_predict

        if lengths and lengths.get("avg", 999) < 50:
            recs.append(
                f"Responses average only {lengths['avg']} tokens — add an explicit minimum-length "
                "instruction to scenarioPrompt, e.g. 'Write at least 4 sentences per response.'"
            )

        truncated = lengths.get("truncated_turns", []) if lengths else []
        if len(truncated) > 3:
            recs.append(
                f"{len(truncated)} responses appear truncated (≥95% of num_predict={np_}). "
                f"Increase num_predict to at least {np_ + 50}."
            )

        if speed and speed.get("avg_tps", 999) < 3.0:
            num_ctx = self.config["generation"].get("num_ctx", 4096)
            recs.append(
                f"Generation is slow ({speed['avg_tps']} tok/s average). "
                f"Consider a smaller/quantised model or reducing num_ctx from {num_ctx}."
            )

        if repetition and len(repetition.get("flagged_pairs", [])) > 2:
            rp = self.config["generation"].get("repeat_penalty", 1.1)
            recs.append(
                f"Repetition detected in {len(repetition['flagged_pairs'])} consecutive turn pairs "
                f"(>40% trigram overlap). Increase repeat_penalty from {rp} to {rp + 0.1:.1f}. "
                "Also add 'Never repeat phrases from the previous paragraph' to scenarioPrompt."
            )

        if growth and growth.get("projected_overflow_turn") is not None:
            pt = growth["projected_overflow_turn"]
            nc = growth["num_ctx"]
            recs.append(
                f"Prompt grows ~{growth['growth_rate']} tokens/turn; 80% of num_ctx ({nc}) "
                f"will be reached around turn {pt}. Consider reducing contextMaxMessages in config.json."
            )

        sms = compliance.get("starts_mid_sentence", []) if compliance else []
        if len(sms) > 5:
            recs.append(
                f"{len(sms)} responses start mid-sentence. Strengthen the 'Lead with the consequence' "
                "instruction in customSystemPrompt."
            )

        ooc = compliance.get("contains_ooc_brackets", []) if compliance else []
        if ooc:
            recs.append(
                f"OOC brackets appeared in {len(ooc)} turn(s) (turns {ooc}). "
                "Add 'No brackets, no meta-commentary' to scenarioPrompt."
            )

        apologies = compliance.get("contains_apology", []) if compliance else []
        if apologies:
            recs.append(
                f"Refusal-like text appeared in {len(apologies)} turn(s) (turns {apologies}). "
                "The model may be safety-filtering — review the scenario prompt for triggering content."
            )

        resp = responsiveness or {}
        if "say" in resp and "do" in resp:
            say_avg = resp["say"]["avg_tokens"]
            do_avg = resp["do"]["avg_tokens"]
            if say_avg < do_avg * 0.7:
                recs.append(
                    f"'say' actions produce much shorter responses ({say_avg} avg) than "
                    f"'do' actions ({do_avg} avg). Extend the 'say' actionPrompt: "
                    "'Echo the words fully, then show every character's reaction.'"
                )

        if not recs:
            recs.append("No significant issues detected — prompts appear to be working well.")

        return recs

    def run_all(self):
        lengths = self.analyze_response_lengths()
        speed = self.analyze_generation_speed()
        growth = self.analyze_prompt_growth()
        repetition = self.analyze_repetition()
        responsiveness = self.analyze_action_responsiveness()
        compliance = self.analyze_format_compliance()
        recommendations = self.generate_recommendations(
            lengths, speed, growth, repetition, responsiveness, compliance
        )
        return {
            "lengths": lengths,
            "speed": speed,
            "growth": growth,
            "repetition": repetition,
            "responsiveness": responsiveness,
            "compliance": compliance,
            "recommendations": recommendations,
        }


# ── ReportWriter ───────────────────────────────────────────────────────────────

class ReportWriter:
    """Renders analysis metrics as a Markdown file."""

    def __init__(self, reports_dir):
        self.reports_dir = Path(reports_dir)
        self.reports_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _sparkline(values):
        if not values:
            return ""
        mn, mx = min(values), max(values)
        blocks = "▁▂▃▄▅▆▇█"
        if mx == mn:
            return blocks[3] * len(values)
        return "".join(blocks[round((v - mn) / (mx - mn) * 7)] for v in values)

    def write(self, metrics, config, records, game_id):
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        fpath = self.reports_dir / f"analysis_{ts}.md"

        ok_records = [r for r in records if r.error is None]
        total_tokens = sum(r.completion_tokens for r in ok_records)
        total_ms = sum(r.duration_ms for r in ok_records)
        total_sec = total_ms // 1000
        duration_str = f"{total_sec // 60}m {total_sec % 60}s"

        lines = [
            "# StoryTelling Playthrough Analysis",
            "",
            f"**Date:** {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  ",
            f"**Scenario:** {config.get('scenario_id', '?')}  ",
            f"**Model:** {config.get('model_id', '?')}  ",
            f"**Game ID:** {game_id}  ",
            f"**Turns completed:** {len(ok_records)}/{len(records)}  ",
            f"**Total tokens generated:** {total_tokens:,}  ",
            f"**Total generation time:** {duration_str}  ",
            "",
            "---",
            "",
        ]

        L = metrics["lengths"]
        if L:
            np_ = config["generation"]["num_predict"]
            short_list = [t["index"] for t in L["short_turns"]]
            trunc_list = [t["index"] for t in L["truncated_turns"]]
            lines += [
                "## 1. Response Length Distribution",
                "",
                "| Metric | Value |",
                "|--------|-------|",
                f"| Average completion tokens | {L['avg']} |",
                f"| Median | {L['median']} |",
                f"| Min | {L['min']} (Turn {L['min_turn']}) |",
                f"| Max | {L['max']} (Turn {L['max_turn']}) |",
                f"| Short responses (<30 tokens) | {len(short_list)} — turns {short_list} |",
                f"| Truncated (≥95% of num\\_predict={np_}) | {len(trunc_list)} — turns {trunc_list} |",
                "",
            ]

        S = metrics["speed"]
        if S:
            spark = self._sparkline([d["tps"] for d in S["by_turn"]])
            f = S["fastest_turn"]
            sl = S["slowest_turn"]
            lines += [
                "## 2. Generation Speed",
                "",
                "| Metric | Value |",
                "|--------|-------|",
                f"| Average | {S['avg_tps']} tok/s |",
                f"| Fastest | Turn {f['index']} — {f['tps']} tok/s ({f['duration_ms']}ms) |",
                f"| Slowest | Turn {sl['index']} — {sl['tps']} tok/s ({sl['duration_ms']}ms) |",
                "",
                "**Speed per turn (tok/s):**",
                "```",
                spark,
                "```",
                "",
            ]

        G = metrics["growth"]
        if G:
            lines += [
                "## 3. Prompt Token Growth",
                "",
                "| Turn | Prompt Tokens |",
                "|------|--------------|",
            ]
            for s in G["sampled"]:
                lines.append(f"| {s['turn']} | {s['prompt_tokens']:,} |")
            lines += [
                "",
                f"**Growth rate:** ~{G['growth_rate']} tokens/turn  ",
                f"**Range:** {G['first_tokens']:,} → {G['last_tokens']:,} (+{G['total_growth']:,} tokens)  ",
            ]
            if G["projected_overflow_turn"]:
                lines.append(
                    f"**Overflow warning:** 80% of num\\_ctx={G['num_ctx']} "
                    f"projected at ~Turn {G['projected_overflow_turn']}  "
                )
            else:
                lines.append("**Context overflow risk:** None within playthrough range  ")
            lines.append("")

        R = metrics["repetition"]
        lines += ["## 4. Repetition Detection", ""]
        if R.get("flagged_pairs"):
            lines.append(f"**{len(R['flagged_pairs'])} flagged pair(s)** (>40% trigram overlap):")
            lines.append("")
            for p in R["flagged_pairs"]:
                lines.append(f"- Turns {p['turns'][0]}→{p['turns'][1]}: {p['overlap_ratio']*100:.1f}% overlap")
        else:
            lines.append("No consecutive pairs exceeded the 40% trigram overlap threshold.")
        lines += [
            "",
            f"Avg overlap: {R.get('avg_overlap', 0)*100:.1f}% | "
            f"Max overlap: {R.get('max_overlap', 0)*100:.1f}%",
            "",
        ]

        RESP = metrics["responsiveness"]
        lines += [
            "## 5. Action-Type Responsiveness",
            "",
            "| Type | Count | Avg Tokens | Min | Max |",
            "|------|-------|------------|-----|-----|",
        ]
        for atype in ["do", "say", "story"]:
            if atype in RESP:
                d = RESP[atype]
                lines.append(
                    f"| {atype} | {d['count']} | {d['avg_tokens']} | {d['min_tokens']} | {d['max_tokens']} |"
                )
        lines.append("")

        C = metrics["compliance"]
        issue_labels = [
            ("Starts mid-sentence", "starts_mid_sentence"),
            ('Ends with "..."', "ends_with_ellipsis"),
            ("OOC brackets found", "contains_ooc_brackets"),
            ("Contains apology", "contains_apology"),
        ]
        lines += [
            "## 6. Format Compliance",
            "",
            "| Issue | Count | Affected turns |",
            "|-------|-------|----------------|",
        ]
        for label, key in issue_labels:
            turns = C.get(key, [])
            turns_str = str(turns) if turns else "—"
            lines.append(f"| {label} | {len(turns)} | {turns_str} |")
        lines.append("")

        lines += ["## 7. Recommendations", ""]
        for i, rec in enumerate(metrics["recommendations"], 1):
            lines.append(f"{i}. {rec}")
        lines.append("")

        lines += [
            "---",
            "",
            "## Turn Log",
            "",
            "| # | Type | Action | Response preview | Prompt tok | Compl tok | ms |",
            "|---|------|--------|-----------------|------------|-----------|-----|",
        ]
        for r in records:
            action_prev = r.raw_input[:40].replace("|", "\\|")
            if r.error:
                resp_prev = f"ERROR: {r.error[:50]}"
            else:
                resp_prev = r.response[:50].replace("\n", " ").replace("|", "\\|") + "..."
            lines.append(
                f"| {r.turn_index} | {r.action_type} | {action_prev} | {resp_prev} "
                f"| {r.prompt_tokens} | {r.completion_tokens} | {r.duration_ms} |"
            )
        lines.append("")

        with open(fpath, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))

        return str(fpath)


# ── Config selector ───────────────────────────────────────────────────────────

def select_config():
    """Scan tests/configs/*.json and let the user pick one interactively."""
    configs_dir = PROJECT_ROOT / "tests" / "configs"
    configs = sorted(configs_dir.glob("*.json")) if configs_dir.exists() else []

    if not configs:
        print(f"ERROR: No configs found in {configs_dir}")
        sys.exit(1)

    if len(configs) == 1:
        return configs[0]

    # Build display rows
    rows = []
    for c in configs:
        try:
            with open(c, encoding="utf-8") as f:
                d = json.load(f)
            scenario = d.get("scenario_id", "?")
            model = d.get("model_id", "?")
            n = len(d.get("actions", []))
            rows.append((c, scenario, model, n))
        except Exception:
            rows.append((c, c.stem, "?", 0))

    print("\nAvailable configs:")
    name_w = max(len(r[1]) for r in rows)
    model_w = max(len(r[2]) for r in rows)
    for i, (_, scenario, model, n) in enumerate(rows, 1):
        print(f"  {i}.  {scenario:<{name_w}}  {model:<{model_w}}  ({n} actions)")

    while True:
        try:
            raw = input(f"\nSelect [1-{len(rows)}]: ").strip()
            if not raw:
                return rows[0][0]
            idx = int(raw) - 1
            if 0 <= idx < len(rows):
                return rows[idx][0]
        except (ValueError, KeyboardInterrupt, EOFError):
            print("\nAborted.")
            sys.exit(0)
        print(f"  Please enter a number between 1 and {len(rows)}.")


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("  StoryTelling — Playthrough Test + Prompt Analysis")
    print("=" * 60)

    # Direct path arg skips the menu
    if len(sys.argv) > 1:
        config_path = Path(sys.argv[1])
        if not config_path.exists():
            print(f"ERROR: Config not found: {config_path}")
            sys.exit(1)
    else:
        config_path = select_config()

    print(f"\nUsing config: {config_path.name}")

    with open(config_path, encoding="utf-8") as f:
        config = json.load(f)

    n_actions = len(config.get("actions", []))
    if n_actions != 30:
        print(f"WARNING: Expected 30 actions, got {n_actions}")

    runner = PlaythroughRunner(config)
    records = runner.run()
    game_id = runner.game_id

    print("Analyzing results...")
    metrics = Analyzer(records, config).run_all()

    reports_dir = PROJECT_ROOT / config.get("reports_dir", "tests/reports")
    report_path = ReportWriter(reports_dir).write(metrics, config, records, game_id)

    print(f"Report written: {report_path}")

    recs = metrics["recommendations"]
    if recs:
        print("\nRecommendations:")
        for i, rec in enumerate(recs, 1):
            print(f"  {i}. {rec[:100]}{'...' if len(rec) > 100 else ''}")


if __name__ == "__main__":
    main()
