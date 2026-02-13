from apig_wsgi import make_lambda_handler
from app import create_app

app = create_app()

# Lambda handler for API Gateway HTTP API
handler = make_lambda_handler(app)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
