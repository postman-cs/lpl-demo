from __future__ import annotations

import uuid
from datetime import datetime, timezone

from marshmallow import Schema, fields, validate, post_load


# ---------------------------------------------------------------------------
# Domain models
# ---------------------------------------------------------------------------


class Portfolio:
    def __init__(self, client_id, portfolio_name, investment_objective,
                 risk_tolerance="moderate", benchmark_index="", currency="USD",
                 status="active", portfolio_id=None, advisor_id=None,
                 total_value=0.0, created_at=None, updated_at=None):
        self.portfolio_id = portfolio_id or str(uuid.uuid4())
        self.client_id = client_id
        self.advisor_id = advisor_id or str(uuid.uuid4())
        self.portfolio_name = portfolio_name
        self.status = status
        self.investment_objective = investment_objective
        self.risk_tolerance = risk_tolerance
        self.total_value = total_value
        self.currency = currency
        self.benchmark_index = benchmark_index
        now = datetime.now(timezone.utc)
        self.created_at = created_at or now
        self.updated_at = updated_at or now

    def to_dict(self):
        return {
            "portfolioId": self.portfolio_id,
            "clientId": self.client_id,
            "advisorId": self.advisor_id,
            "portfolioName": self.portfolio_name,
            "status": self.status,
            "investmentObjective": self.investment_objective,
            "riskTolerance": self.risk_tolerance,
            "totalValue": self.total_value,
            "currency": self.currency,
            "benchmarkIndex": self.benchmark_index,
            "createdAt": self.created_at.isoformat(),
            "updatedAt": self.updated_at.isoformat(),
        }


class Trade:
    def __init__(self, portfolio_id, instrument_type, ticker, side, quantity,
                 order_type="market", limit_price=None, trade_id=None,
                 price_per_unit=None, status="pending", compliance_status="approved",
                 initiated_at=None, executed_at=None, settled_at=None):
        self.trade_id = trade_id or str(uuid.uuid4())
        self.portfolio_id = portfolio_id
        self.instrument_type = instrument_type
        self.ticker = ticker
        self.side = side
        self.quantity = quantity
        self.order_type = order_type
        self.limit_price = limit_price
        self.price_per_unit = price_per_unit or round(150.0 + (hash(ticker) % 200), 2)
        self.total_amount = round(self.price_per_unit * quantity, 2)
        self.currency = "USD"
        self.status = status
        self.compliance_status = compliance_status
        now = datetime.now(timezone.utc)
        self.initiated_at = initiated_at or now
        self.executed_at = executed_at
        self.settled_at = settled_at

    def to_dict(self):
        d = {
            "tradeId": self.trade_id,
            "portfolioId": self.portfolio_id,
            "instrumentType": self.instrument_type,
            "ticker": self.ticker,
            "side": self.side,
            "quantity": self.quantity,
            "pricePerUnit": self.price_per_unit,
            "totalAmount": self.total_amount,
            "currency": self.currency,
            "status": self.status,
            "complianceStatus": self.compliance_status,
            "initiatedAt": self.initiated_at.isoformat(),
        }
        if self.executed_at:
            d["executedAt"] = self.executed_at.isoformat()
        if self.settled_at:
            d["settledAt"] = self.settled_at.isoformat()
        return d


# ---------------------------------------------------------------------------
# Marshmallow schemas
# ---------------------------------------------------------------------------

OBJECTIVES = ["growth", "income", "balanced", "preservation", "aggressive-growth"]
RISK_LEVELS = ["conservative", "moderate", "aggressive"]
PORTFOLIO_STATUSES = ["active", "suspended", "closed", "pending-review"]
INSTRUMENT_TYPES = ["equity", "fixed-income", "etf", "mutual-fund", "option"]
TRADE_SIDES = ["buy", "sell"]
ORDER_TYPES = ["market", "limit", "stop", "stop-limit"]
TRADE_STATUSES = ["pending", "executed", "settled", "cancelled", "rejected"]


class PortfolioInitiateSchema(Schema):
    clientId = fields.String(required=True)
    portfolioName = fields.String(required=True, validate=validate.Length(min=1, max=255))
    investmentObjective = fields.String(required=True, validate=validate.OneOf(OBJECTIVES))
    riskTolerance = fields.String(load_default="moderate", validate=validate.OneOf(RISK_LEVELS))
    benchmarkIndex = fields.String(load_default="")
    currency = fields.String(load_default="USD", validate=validate.Regexp(r"^[A-Z]{3}$"))

    @post_load
    def make_portfolio(self, data, **kwargs):
        return Portfolio(
            client_id=data["clientId"],
            portfolio_name=data["portfolioName"],
            investment_objective=data["investmentObjective"],
            risk_tolerance=data.get("riskTolerance", "moderate"),
            benchmark_index=data.get("benchmarkIndex", ""),
            currency=data.get("currency", "USD"),
        )


class PortfolioUpdateSchema(Schema):
    portfolioName = fields.String(required=True, validate=validate.Length(min=1, max=255))
    investmentObjective = fields.String(validate=validate.OneOf(OBJECTIVES))
    riskTolerance = fields.String(validate=validate.OneOf(RISK_LEVELS))
    status = fields.String(validate=validate.OneOf(PORTFOLIO_STATUSES))
    benchmarkIndex = fields.String()


class TradeInitiateSchema(Schema):
    instrumentType = fields.String(required=True, validate=validate.OneOf(INSTRUMENT_TYPES))
    ticker = fields.String(required=True, validate=validate.Length(min=1, max=10))
    side = fields.String(required=True, validate=validate.OneOf(TRADE_SIDES))
    quantity = fields.Float(required=True, validate=validate.Range(min=0, min_inclusive=False))
    limitPrice = fields.Float(validate=validate.Range(min=0))
    orderType = fields.String(load_default="market", validate=validate.OneOf(ORDER_TYPES))


# ---------------------------------------------------------------------------
# In-memory stores
# ---------------------------------------------------------------------------

_portfolios: dict[str, Portfolio] = {}
_trades: dict[str, list[Trade]] = {}  # keyed by portfolio_id


def get_portfolio_store() -> dict[str, Portfolio]:
    return _portfolios


def get_trade_store() -> dict[str, list[Trade]]:
    return _trades


def reset_stores():
    _portfolios.clear()
    _trades.clear()
