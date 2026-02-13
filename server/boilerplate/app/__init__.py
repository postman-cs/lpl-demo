from flask import Flask
from flask_cors import CORS


def create_app():
    app = Flask(__name__)
    CORS(app)

    from app.routes import api_bp, ops_bp

    app.register_blueprint(ops_bp)
    app.register_blueprint(api_bp, url_prefix="/api/v1")

    return app
