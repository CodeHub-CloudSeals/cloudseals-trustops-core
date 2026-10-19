"""CrewAI Flows evaluation with native non-blocking human feedback and SQLite persistence."""
import json
from pathlib import Path

from crewai.flow import Flow, HumanFeedbackPending, human_feedback, listen, start
from crewai.flow.persistence import SQLiteFlowPersistence
from pydantic import BaseModel, Field

from experiments.orchestration import common


class State(BaseModel):
    scenario: str = 'approved'
    items: list = Field(default_factory=list)
    findings: list = Field(default_factory=list)
    review_digest: str = ''
    status: str = 'started'
    report: dict | None = None
    events: list[str] = Field(default_factory=list)


class AnalysisFlow(Flow[State]):
    """No crew/LLM autonomy added: identical bounded product calls for a fair Flow comparison."""
    calls: list = Field(default_factory=list)

    @start()
    def inventory(self):
        self.state.items = common.inventory(self.state.scenario, self.calls)
        self.state.events.append('inventory')
        return self.state.items

    @listen(inventory)
    def gaps(self, _):
        self.state.findings = common.gaps(self.state.items, self.state.scenario, self.calls)
        self.state.events.append('gap_analysis')
        return self.state.findings


class PauseForReview:
    def request_feedback(self, context, flow):
        raise HumanFeedbackPending(context=context, callback_info={'evaluation_only': True})


class ReviewFlow(Flow[State]):
    calls: list = Field(default_factory=list)

    @start()
    def inventory(self):
        self.state.items = common.inventory(self.state.scenario, self.calls)
        self.state.events.append('inventory')
        return self.state.items

    @listen(inventory)
    def gaps(self, _):
        self.state.findings = common.gaps(self.state.items, self.state.scenario, self.calls)
        self.state.events.append('gap_analysis')
        return self.state.findings

    @listen(gaps)
    @human_feedback(message='Review the synthetic evidence digest.', provider=PauseForReview())
    def review(self, _):
        self.state.review_digest = common.digest(self.state.items, self.state.findings)
        self.state.status = 'awaiting_review'
        self.state.events.append('awaiting_review')
        return {'digest': self.state.review_digest}

    @listen(review)
    def report_draft(self, feedback):
        approved = common.decision(feedback.feedback, self.state.review_digest)
        result = common.report(self.state.items, self.state.findings, approved)
        self.state.status, self.state.report = result['status'], result['report']
        self.state.events.extend(['review', 'report_draft'])
        return result


def run(db, scenario, calls, review=None, hybrid=False):
    persistence = SQLiteFlowPersistence(str(db))
    id_file = Path(str(db) + '.flow-id')
    if review:
        flow = ReviewFlow.from_pending(id_file.read_text(), persistence=persistence)
        # Validate before consuming pending review context.
        common.decision(review, flow.state.review_digest)
        flow.calls = calls
        previous_events = len(flow.state.events)
        flow.resume(json.dumps(review))
        return flow.state.model_dump(), flow.state.events[previous_events:]
    flow = ReviewFlow(persistence=persistence)
    flow.calls = calls
    flow.state.scenario = scenario
    pending = flow.kickoff()
    if not isinstance(pending, HumanFeedbackPending):
        raise AssertionError('The workflow did not stop for a reviewer')
    id_file.write_text(pending.context.flow_id)
    return flow.state.model_dump(), flow.state.events
