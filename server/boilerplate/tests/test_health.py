from app import create_app


def test_health_returns_200():
    app = create_app()
    client = app.test_client()
    resp = client.get("/health")
    assert resp.status_code == 200


def test_health_returns_json():
    app = create_app()
    client = app.test_client()
    resp = client.get("/health")
    data = resp.get_json()
    assert data["status"] == "healthy"
    assert data["service"] == "advisor-portfolio-api"
