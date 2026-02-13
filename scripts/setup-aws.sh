#!/usr/bin/env bash
# Setup AWS resources for the BRAVE-Postman demo
# Run this AFTER configuring AWS CLI credentials
set -euo pipefail

POLICY_NAME="brave-postman-demo-policy"
USER_NAME="brave-postman-demo"
SECRET_NAME="api-credentials-dev"
REGION="us-east-1"

echo "== AWS Demo Setup =="
echo ""

# 1. Create IAM policy
echo "Creating IAM policy: $POLICY_NAME"
POLICY_ARN=$(aws iam create-policy \
    --policy-name "$POLICY_NAME" \
    --policy-document file://scripts/iam-policy.json \
    --query 'Policy.Arn' --output text 2>/dev/null || \
    aws iam list-policies --query "Policies[?PolicyName=='$POLICY_NAME'].Arn" --output text)
echo "  Policy ARN: $POLICY_ARN"

# 2. Create IAM user
echo "Creating IAM user: $USER_NAME"
aws iam create-user --user-name "$USER_NAME" 2>/dev/null || echo "  User already exists"
aws iam attach-user-policy --user-name "$USER_NAME" --policy-arn "$POLICY_ARN"

# 3. Create access key
echo "Creating access key..."
KEY_OUTPUT=$(aws iam create-access-key --user-name "$USER_NAME" --output json)
ACCESS_KEY_ID=$(echo "$KEY_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['AccessKey']['AccessKeyId'])")
SECRET_KEY=$(echo "$KEY_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['AccessKey']['SecretAccessKey'])")

echo ""
echo "  AWS_ACCESS_KEY_ID=$ACCESS_KEY_ID"
echo "  AWS_SECRET_ACCESS_KEY=$SECRET_KEY"
echo ""

# 4. Create Secrets Manager secret
echo "Creating Secrets Manager secret: $SECRET_NAME"
aws secretsmanager create-secret \
    --name "$SECRET_NAME" \
    --region "$REGION" \
    --secret-string '{"api_key":"demo-api-key-12345","auth_token":"demo-bearer-token-67890"}' \
    2>/dev/null || \
aws secretsmanager update-secret \
    --secret-id "$SECRET_NAME" \
    --region "$REGION" \
    --secret-string '{"api_key":"demo-api-key-12345","auth_token":"demo-bearer-token-67890"}'
echo "  Secret created/updated"

# 5. Verify
echo ""
echo "== Verification =="
echo "Retrieving secret to verify..."
aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --region "$REGION" \
    --query 'SecretString' --output text | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  Keys: {list(d.keys())}')"

echo ""
echo "== Done =="
echo "Add these to orchestrator/.env:"
echo "  AWS_ACCESS_KEY_ID=$ACCESS_KEY_ID"
echo "  AWS_SECRET_ACCESS_KEY=$SECRET_KEY"
echo "  AWS_REGION=$REGION"
