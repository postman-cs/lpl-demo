#!/usr/bin/env python3
"""Teardown script for BRAVE-Postman demo resources.

Deletes all provisioned resources: Postman workspace, GitHub repo,
AWS Lambda + API Gateway + IAM role.

Usage:
    python scripts/teardown.py --project "advisor-portfolio-api"
    python scripts/teardown.py --project "advisor-portfolio-api" --dry-run
    python scripts/teardown.py --result provisioning-result.json
"""

import argparse
import json
import logging
import os
import sys

import boto3
import requests
from botocore.exceptions import ClientError
from dotenv import load_dotenv

load_dotenv("orchestrator/.env")

logger = logging.getLogger("teardown")


def teardown_postman(workspace_id: str, api_key: str, dry_run: bool = False):
    """Delete a Postman workspace and all its contents."""
    headers = {"X-Api-Key": api_key}

    if dry_run:
        resp = requests.get(
            f"https://api.getpostman.com/workspaces/{workspace_id}",
            headers=headers,
        )
        if resp.ok:
            name = resp.json().get("workspace", {}).get("name", "unknown")
            logger.info("[DRY RUN] Would delete workspace: %s (%s)", name, workspace_id)
        else:
            logger.warning("[DRY RUN] Workspace %s not found", workspace_id)
        return

    resp = requests.delete(
        f"https://api.getpostman.com/workspaces/{workspace_id}",
        headers=headers,
    )
    if resp.ok:
        logger.info("Deleted Postman workspace: %s", workspace_id)
    elif resp.status_code == 404:
        logger.info("Workspace %s already deleted", workspace_id)
    else:
        logger.warning("Failed to delete workspace %s: %s", workspace_id, resp.text)


def teardown_github(repo_name: str, org: str, token: str, dry_run: bool = False):
    """Delete a GitHub repository."""
    headers = {"Authorization": f"token {token}"}

    if dry_run:
        resp = requests.get(
            f"https://api.github.com/repos/{org}/{repo_name}",
            headers=headers,
        )
        if resp.ok:
            logger.info("[DRY RUN] Would delete repo: %s/%s", org, repo_name)
        else:
            logger.info("[DRY RUN] Repo %s/%s not found", org, repo_name)
        return

    resp = requests.delete(
        f"https://api.github.com/repos/{org}/{repo_name}",
        headers=headers,
    )
    if resp.status_code in (204, 404):
        logger.info("Deleted GitHub repo: %s/%s", org, repo_name)
    else:
        logger.warning("Failed to delete repo: %s", resp.text)


def teardown_aws(function_name: str, region: str, dry_run: bool = False):
    """Delete Lambda function, API Gateway, and IAM role."""
    session = boto3.Session(region_name=region)

    # Delete API Gateway
    apigw = session.client("apigatewayv2")
    try:
        apis = apigw.get_apis()
        api_name = f"{function_name}-api"
        for api in apis.get("Items", []):
            if api["Name"] == api_name:
                if dry_run:
                    logger.info("[DRY RUN] Would delete API Gateway: %s", api_name)
                else:
                    apigw.delete_api(ApiId=api["ApiId"])
                    logger.info("Deleted API Gateway: %s", api_name)
    except ClientError as e:
        logger.warning("API Gateway cleanup: %s", e)

    # Delete Lambda
    lam = session.client("lambda")
    try:
        if dry_run:
            lam.get_function(FunctionName=function_name)
            logger.info("[DRY RUN] Would delete Lambda: %s", function_name)
        else:
            lam.delete_function(FunctionName=function_name)
            logger.info("Deleted Lambda: %s", function_name)
    except ClientError as e:
        if "ResourceNotFoundException" in str(e):
            logger.info("Lambda %s already deleted", function_name)
        else:
            logger.warning("Lambda cleanup: %s", e)

    # Delete IAM role (with cse-lpl- prefix matching aws.py)
    iam = session.client("iam")
    role_name = f"cse-lpl-{function_name}-lambda-role"
    try:
        if dry_run:
            iam.get_role(RoleName=role_name)
            logger.info("[DRY RUN] Would delete IAM role: %s", role_name)
        else:
            # Detach policies first
            policies = iam.list_attached_role_policies(RoleName=role_name)
            for p in policies.get("AttachedPolicies", []):
                iam.detach_role_policy(RoleName=role_name, PolicyArn=p["PolicyArn"])
            iam.delete_role(RoleName=role_name)
            logger.info("Deleted IAM role: %s", role_name)
    except ClientError as e:
        if "NoSuchEntity" in str(e):
            logger.info("IAM role %s already deleted", role_name)
        else:
            logger.warning("IAM role cleanup: %s", e)

    # Delete CloudWatch log group (persists after Lambda deletion)
    logs = session.client("logs")
    log_group = f"/aws/lambda/{function_name}"
    try:
        if dry_run:
            logs.describe_log_groups(logGroupNamePrefix=log_group)
            logger.info("[DRY RUN] Would delete log group: %s", log_group)
        else:
            logs.delete_log_group(logGroupName=log_group)
            logger.info("Deleted log group: %s", log_group)
    except ClientError as e:
        if "ResourceNotFoundException" in str(e):
            logger.info("Log group %s already deleted", log_group)
        else:
            logger.warning("CloudWatch cleanup: %s", e)


def main():
    parser = argparse.ArgumentParser(description="Teardown BRAVE-Postman demo resources")
    parser.add_argument("--project", help="Project name (used to derive resource names)")
    parser.add_argument("--result", help="Path to provisioning-result.json")
    parser.add_argument("--dry-run", action="store_true", help="Preview what would be deleted")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    postman_api_key = os.getenv("POSTMAN_API_KEY", "")
    github_token = os.getenv("GITHUB_TOKEN", "")
    github_org = os.getenv("GITHUB_ORG", "postman-cs")
    aws_region = os.getenv("AWS_REGION", "us-east-1")

    if args.result:
        with open(args.result) as f:
            result = json.load(f)
        workspace_id = result["resources"]["postman"]["workspace_id"]
        repo_name = result["resources"]["github"].get("repo_url", "").rstrip("/").split("/")[-1]
        function_name = result["resources"]["aws"]["function_name"]
    elif args.project:
        repo_name = args.project.lower().replace(" ", "-").replace("_", "-")
        function_name = repo_name
        # Need to find workspace ID by listing
        workspace_id = _find_workspace_id(repo_name, postman_api_key)
    else:
        parser.error("Provide --project or --result")
        return

    prefix = "[DRY RUN] " if args.dry_run else ""
    logger.info("%sTearing down: %s", prefix, repo_name)

    if workspace_id:
        teardown_postman(workspace_id, postman_api_key, args.dry_run)
    else:
        logger.warning("No workspace ID found -- skipping Postman teardown")

    teardown_github(repo_name, github_org, github_token, args.dry_run)
    teardown_aws(function_name, aws_region, args.dry_run)

    logger.info("%sTeardown complete", prefix)


def _find_workspace_id(project_name: str, api_key: str) -> str:
    """Find workspace ID by searching for the workspace name."""
    headers = {"X-Api-Key": api_key}
    resp = requests.get("https://api.getpostman.com/workspaces", headers=headers)
    if not resp.ok:
        return ""
    for ws in resp.json().get("workspaces", []):
        if project_name in ws.get("name", "").lower():
            return ws["id"]
    return ""


if __name__ == "__main__":
    main()
