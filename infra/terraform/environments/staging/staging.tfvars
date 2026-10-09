# Replace placeholders before plan. No secrets belong in this file.
portal_urls           = ["https://taad-staging.example.invalid/portal/"]
cognito_domain_prefix = "cloudseals-taad-staging"
alarm_email           = "platform-alerts@example.invalid"
github_repository     = "cloudseals/trustops-taad"
# certificate_arn     = "arn:aws:acm:eu-west-2:ACCOUNT:certificate/ID"   # required for staging/prod
# bedrock_model_id    = ""    # empty => Swaska uses the deterministic renderer
