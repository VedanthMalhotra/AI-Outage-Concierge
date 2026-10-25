# Hosting on AWS

The dashboard, backend API and Nova chatbot run on **one EC2 server** in the hackathon sandbox (us-east-2).

**Live site (use this link):** https://d22vd18uidf0yz.cloudfront.net/ (HTTPS via CloudFront, stays the same even if the server's IP changes)
Direct server address (HTTP, changes after a stop/start): http://3.21.44.48/

## Resources created (delete after the hackathon)
| Resource | Name / ID | Purpose |
|---|---|---|
| EC2 instance | `i-08a3da92e46ccadfa` (t3.small, tag `aep-concierge`) | Runs the app on port 80 (~$0.02/h) |
| Security group | `sg-07136c738d0d65988` (`aep-concierge-web`) | Allows HTTP (port 80) only |
| IAM role + instance profile | `aep-concierge-ec2` | Server can read the bucket (`processed/`, `features/`, `deploy/`) and call Bedrock (Nova). Session Manager for debugging. No keys stored. |
| S3 object | `s3://sagemaker-aep-outage-indiansassemble/deploy/aep-app.zip` | The packaged app the server installs |
| CloudFront distribution | `E26TNDOC0IEHCY` (`d22vd18uidf0yz.cloudfront.net`) | Free HTTPS address in front of the server. No caching, all request types allowed, forwards to the server's public DNS name over HTTP. |

## How it's set up
- The server's startup script (`user-data`) installs Python 3.11, downloads `deploy/aep-app.zip`, installs the backend's dependencies and runs `uvicorn app.main:app --port 80` as a systemd service (`aep`), which restarts automatically.
- `AEP_STATIC_DIR=/opt/aep/site` makes the backend serve the built dashboard too, so the site and API share one address. `/` redirects to `/web/index.html`.
- The dashboard is built with `VITE_API_BASE=/` so it calls the API on the same server.
- Safeguards for a public site: a "student prototype, not an official AEP website" banner, and a chat limit of 20 messages per 10 minutes per visitor.

## Update the site after code changes
From the repo root, after `git pull` (and `aws sso login --sso-session osu-sandbox` if your login expired):
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```
It does the steps below and checks that the site is back up (about 1–2 minutes). The manual steps, for reference:

1. Build the dashboard (from `web/`): set `VITE_API_BASE=/`, then `npm run build`.
2. Package `backend/app` + `backend/pyproject.toml`, `web/dist/*` (as `site/`) and `mock/` into `aep-app.zip` with forward-slash paths, and upload it to `s3://sagemaker-aep-outage-indiansassemble/deploy/aep-app.zip`.
3. Tell the server to reinstall and restart (no SSH needed):
   ```bash
   aws ssm send-command --instance-ids i-08a3da92e46ccadfa --document-name AWS-RunShellScript --parameters "commands=['aws s3 cp s3://sagemaker-aep-outage-indiansassemble/deploy/aep-app.zip /tmp/aep-app.zip --region us-east-2','unzip -o /tmp/aep-app.zip -d /opt/aep','systemctl restart aep']"
   ```

## Stop or delete
- **Pause (keeps everything, stops compute cost):** console **EC2 → Instances → `aep-concierge` → Instance state → Stop**, or `aws ec2 stop-instances --instance-ids i-08a3da92e46ccadfa`. **Start** it the same way.
- **After a restart the server gets a new public IP and DNS name**, so CloudFront must be pointed at it: console **CloudFront → `E26TNDOC0IEHCY` → Origins → edit `aep-ec2` → Origin domain** = the new **Public IPv4 DNS** from the EC2 instance page (`ec2-…compute.amazonaws.com`) → Save. The HTTPS link itself stays the same.
- **Delete after judging:** first disable the CloudFront distribution (console **CloudFront → `E26TNDOC0IEHCY` → Disable**, wait until "Deployed", then **Delete**), then:
  ```bash
  aws ec2 terminate-instances --instance-ids i-08a3da92e46ccadfa
  aws ec2 delete-security-group --group-id sg-07136c738d0d65988
  aws iam remove-role-from-instance-profile --instance-profile-name aep-concierge-ec2 --role-name aep-concierge-ec2
  aws iam delete-instance-profile --instance-profile-name aep-concierge-ec2
  aws iam delete-role-policy --role-name aep-concierge-ec2 --policy-name aep-concierge-access
  aws iam detach-role-policy --role-name aep-concierge-ec2 --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam delete-role --role-name aep-concierge-ec2
  ```
  (Wait for the instance to finish terminating before deleting the security group.)
