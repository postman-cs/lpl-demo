from __future__ import annotations

from datetime import datetime, timezone

from flask import Blueprint, jsonify, request
from marshmallow import ValidationError

from app.models import (
    Portfolio, Trade,
    PortfolioInitiateSchema, PortfolioUpdateSchema, TradeInitiateSchema,
    get_portfolio_store, get_trade_store,
)

ops_bp = Blueprint("ops", __name__)
api_bp = Blueprint("api", __name__)

portfolio_initiate_schema = PortfolioInitiateSchema()
portfolio_update_schema = PortfolioUpdateSchema()
trade_initiate_schema = TradeInitiateSchema()


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------


@ops_bp.route("/health", methods=["GET"])
def health_check():
    return jsonify({
        "status": "healthy",
        "service": "advisor-portfolio-api",
        "version": "1.0.0",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


# ---------------------------------------------------------------------------
# Portfolios
# ---------------------------------------------------------------------------


@api_bp.route("/portfolios", methods=["GET"])
def list_portfolios():
    store = get_portfolio_store()
    limit = request.args.get("limit", 20, type=int)
    offset = request.args.get("offset", 0, type=int)
    status_filter = request.args.get("status")
    limit = max(1, min(limit, 100))
    offset = max(0, offset)

    all_items = sorted(store.values(), key=lambda p: p.created_at, reverse=True)
    if status_filter:
        all_items = [p for p in all_items if p.status == status_filter]
    page = all_items[offset:offset + limit]

    return jsonify({
        "portfolios": [p.to_dict() for p in page],
        "total": len(all_items),
        "limit": limit,
        "offset": offset,
    })


@api_bp.route("/portfolios", methods=["POST"])
def initiate_portfolio():
    json_data = request.get_json(silent=True)
    if not json_data:
        return jsonify({"error": "bad_request", "message": "Request body must be JSON"}), 400

    try:
        portfolio = portfolio_initiate_schema.load(json_data)
    except ValidationError as err:
        return jsonify({"error": "validation_error", "message": "Invalid input", "details": err.messages}), 400

    store = get_portfolio_store()
    store[portfolio.portfolio_id] = portfolio
    return jsonify(portfolio.to_dict()), 201


@api_bp.route("/portfolios/<portfolio_id>", methods=["GET"])
def get_portfolio(portfolio_id):
    store = get_portfolio_store()
    portfolio = store.get(portfolio_id)
    if not portfolio:
        return jsonify({"error": "not_found", "message": f"Portfolio {portfolio_id} not found"}), 404
    return jsonify(portfolio.to_dict())


@api_bp.route("/portfolios/<portfolio_id>", methods=["PUT"])
def update_portfolio(portfolio_id):
    store = get_portfolio_store()
    portfolio = store.get(portfolio_id)
    if not portfolio:
        return jsonify({"error": "not_found", "message": f"Portfolio {portfolio_id} not found"}), 404

    json_data = request.get_json(silent=True)
    if not json_data:
        return jsonify({"error": "bad_request", "message": "Request body must be JSON"}), 400

    try:
        validated = portfolio_update_schema.load(json_data)
    except ValidationError as err:
        return jsonify({"error": "validation_error", "message": "Invalid input", "details": err.messages}), 400

    portfolio.portfolio_name = validated["portfolioName"]
    if "investmentObjective" in validated:
        portfolio.investment_objective = validated["investmentObjective"]
    if "riskTolerance" in validated:
        portfolio.risk_tolerance = validated["riskTolerance"]
    if "status" in validated:
        portfolio.status = validated["status"]
    if "benchmarkIndex" in validated:
        portfolio.benchmark_index = validated["benchmarkIndex"]
    portfolio.updated_at = datetime.now(timezone.utc)

    return jsonify(portfolio.to_dict())


# ---------------------------------------------------------------------------
# Trades
# ---------------------------------------------------------------------------


@api_bp.route("/portfolios/<portfolio_id>/trades", methods=["GET"])
def list_trades(portfolio_id):
    portfolio_store = get_portfolio_store()
    if portfolio_id not in portfolio_store:
        return jsonify({"error": "not_found", "message": f"Portfolio {portfolio_id} not found"}), 404

    trade_store = get_trade_store()
    limit = request.args.get("limit", 20, type=int)
    offset = request.args.get("offset", 0, type=int)
    status_filter = request.args.get("status")
    limit = max(1, min(limit, 100))

    trades = trade_store.get(portfolio_id, [])
    if status_filter:
        trades = [t for t in trades if t.status == status_filter]
    trades_sorted = sorted(trades, key=lambda t: t.initiated_at, reverse=True)
    page = trades_sorted[offset:offset + limit]

    return jsonify({
        "trades": [t.to_dict() for t in page],
        "total": len(trades_sorted),
        "limit": limit,
        "offset": offset,
    })


@api_bp.route("/portfolios/<portfolio_id>/trades", methods=["POST"])
def initiate_trade(portfolio_id):
    portfolio_store = get_portfolio_store()
    if portfolio_id not in portfolio_store:
        return jsonify({"error": "not_found", "message": f"Portfolio {portfolio_id} not found"}), 404

    json_data = request.get_json(silent=True)
    if not json_data:
        return jsonify({"error": "bad_request", "message": "Request body must be JSON"}), 400

    try:
        validated = trade_initiate_schema.load(json_data)
    except ValidationError as err:
        return jsonify({"error": "validation_error", "message": "Invalid input", "details": err.messages}), 400

    trade = Trade(
        portfolio_id=portfolio_id,
        instrument_type=validated["instrumentType"],
        ticker=validated["ticker"],
        side=validated["side"],
        quantity=validated["quantity"],
        order_type=validated.get("orderType", "market"),
        limit_price=validated.get("limitPrice"),
    )

    trade_store = get_trade_store()
    trade_store.setdefault(portfolio_id, []).append(trade)

    # Update portfolio total value
    portfolio = portfolio_store[portfolio_id]
    if trade.side == "buy":
        portfolio.total_value += trade.total_amount
    else:
        portfolio.total_value = max(0, portfolio.total_value - trade.total_amount)
    portfolio.updated_at = datetime.now(timezone.utc)

    return jsonify(trade.to_dict()), 201


@api_bp.route("/portfolios/<portfolio_id>/trades/<trade_id>", methods=["GET"])
def get_trade(portfolio_id, trade_id):
    portfolio_store = get_portfolio_store()
    if portfolio_id not in portfolio_store:
        return jsonify({"error": "not_found", "message": f"Portfolio {portfolio_id} not found"}), 404

    trade_store = get_trade_store()
    trades = trade_store.get(portfolio_id, [])
    trade = next((t for t in trades if t.trade_id == trade_id), None)
    if not trade:
        return jsonify({"error": "not_found", "message": f"Trade {trade_id} not found"}), 404

    return jsonify(trade.to_dict())


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------


@api_bp.route("/portfolios/<portfolio_id>/performance", methods=["GET"])
def get_portfolio_performance(portfolio_id):
    portfolio_store = get_portfolio_store()
    portfolio = portfolio_store.get(portfolio_id)
    if not portfolio:
        return jsonify({"error": "not_found", "message": f"Portfolio {portfolio_id} not found"}), 404

    period = request.args.get("period", "1m")

    # Generate representative performance metrics
    return jsonify({
        "portfolioId": portfolio_id,
        "period": period,
        "totalReturn": 8.42,
        "annualizedReturn": 12.15,
        "benchmarkReturn": 7.89,
        "alpha": 0.53,
        "sharpeRatio": 1.34,
        "maxDrawdown": -3.21,
        "volatility": 11.7,
        "asOfDate": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    })
