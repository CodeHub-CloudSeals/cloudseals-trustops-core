"""LangGraph outer workflow; optionally runs the bounded CrewAI Flow as its analysis node."""
import sqlite3
from typing import TypedDict

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from experiments.orchestration import common


class State(TypedDict, total=False):
    scenario: str
    items: list
    findings: list
    review_digest: str
    approved: bool
    status: str
    report: dict | None


def build(connection, calls, hybrid=False):
    def extract(state):
        if hybrid:
            from experiments.orchestration.crewai_adapter import AnalysisFlow
            flow = AnalysisFlow()
            flow.state.scenario = state['scenario']
            flow.calls = calls
            flow.kickoff()
            return {'items': flow.state.items, 'findings': flow.state.findings}
        return {'items': common.inventory(state['scenario'], calls)}

    def analyse(state):
        return {'findings': common.gaps(state['items'], state['scenario'], calls)}

    def review(state):
        d = common.digest(state['items'], state['findings'])
        value = interrupt({'status': 'awaiting_review', 'digest': d})
        return {'approved': common.decision(value, d), 'review_digest': d}

    def render(state):
        return common.report(state['items'], state['findings'], state['approved'])

    graph = StateGraph(State)
    graph.add_node('inventory', extract)
    if not hybrid:
        graph.add_node('gap_analysis', analyse)
        graph.add_edge('inventory', 'gap_analysis')
        graph.add_edge('gap_analysis', 'review')
    else:
        graph.add_edge('inventory', 'review')
    graph.add_node('review', review)
    graph.add_node('report_draft', render)
    graph.add_edge(START, 'inventory')
    graph.add_edge('review', 'report_draft')
    graph.add_edge('report_draft', END)
    return graph.compile(checkpointer=SqliteSaver(connection))


def run(db, scenario, calls, review=None, hybrid=False):
    with sqlite3.connect(db, check_same_thread=False) as connection:
        graph = build(connection, calls, hybrid)
        config = {'configurable': {'thread_id': 'synthetic-tenant:assessment-1'}}
        if review:
            saved = graph.get_state(config)
            if not saved.interrupts:
                raise ValueError('no_pending_review')
            common.decision(review, saved.interrupts[0].value['digest'])
        updates = list(graph.stream(Command(resume=review) if review else {'scenario': scenario}, config, stream_mode='updates'))
        state = dict(graph.get_state(config).values)
        pending = graph.get_state(config).interrupts
        if pending:
            state.update(status='awaiting_review', review_digest=pending[0].value['digest'])
        return state, [name for update in updates for name in update if name != '__interrupt__']
