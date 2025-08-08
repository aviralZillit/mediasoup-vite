# 🚀 MediaSoup ECS Fargate Setup Guide

## Step 1: Get AWS Account Information

### 1.1 AWS Account & Credentials

**If you don't have an AWS account:**
1. Go to https://aws.amazon.com/
2. Click "Create an AWS Account"
3. Follow the signup process (requires credit card)

**Get your AWS credentials:**
1. Sign in to AWS Console: https://console.aws.amazon.com/
2. Navigate to **IAM** (Identity and Access Management)
3. Click **Users** → **[Your Username]** → **Security credentials**
4. Click **Create access key**
5. Choose **Command Line Interface (CLI)**
6. Download or copy:
   - Access Key ID (starts with `AKIA...`)
   - Secret Access Key (long random string)

### 1.2 Choose AWS Region

Pick a region close to your users for better performance:
- **us-east-1** (N. Virginia) - Default, cheapest
- **us-west-2** (Oregon) - West Coast USA
- **eu-west-1** (Ireland) - Europe
- **ap-southeast-1** (Singapore) - Asia

## Step 2: Configure AWS CLI

Run this command and enter your information:

```bash
aws configure
```

You'll be prompted for:
- **AWS Access Key ID**: [Your access key from step 1.1]
- **AWS Secret Access Key**: [Your secret key from step 1.1]
- **Default region name**: `us-east-1` (or your chosen region)
- **Default output format**: `json`

## Step 3: Required Environment Variables

The deployment script uses these variables (with defaults):

```bash
# Required (will be auto-detected)
export AWS_REGION="us-east-1"              # Your chosen region
export AWS_ACCOUNT="123456789012"          # Auto-detected from AWS CLI

# Optional (defaults provided)
export STACK_NAME="mediasoup-production"   # Name for your deployment
export ECR_REPOSITORY="mediasoup-server"   # Container registry name

# Optional (only if you want custom domain)
export DOMAIN_NAME="mediasoup.yourdomain.com"
export CERTIFICATE_ARN="arn:aws:acm:..."
```

## Step 4: What Gets Created Automatically

The deployment script will automatically create:

### 4.1 AWS Resources
- **ECR Repository**: For your Docker images
- **ECS Cluster**: Container orchestration
- **ECS Service**: Running your application
- **Application Load Balancer**: Traffic distribution
- **Security Groups**: Network access rules
- **IAM Roles**: Permissions for services
- **CloudWatch Logs**: Application logging

### 4.2 Default Configuration
- **VPC**: Uses your default VPC (auto-detected)
- **Subnets**: Uses public subnets in your VPC (auto-detected)
- **Container CPU**: 2 vCPU
- **Container Memory**: 4 GB
- **Auto Scaling**: 2-10 instances based on CPU usage
- **Health Checks**: Automatic health monitoring

## Step 5: Optional Custom Domain Setup

**Only if you want a custom domain like `mediasoup.yourdomain.com`:**

### 5.1 Register Domain
- Use Route 53, GoDaddy, Namecheap, etc.
- Point DNS to AWS Route 53 (if using Route 53)

### 5.2 Get SSL Certificate
1. Go to **AWS Certificate Manager** in AWS Console
2. Click **Request a certificate**
3. Choose **Request a public certificate**
4. Enter your domain name (e.g., `mediasoup.yourdomain.com`)
5. Choose **DNS validation**
6. Follow the validation steps
7. Copy the certificate ARN (starts with `arn:aws:acm:`)

## Step 6: Estimated Costs

**Monthly costs for typical usage:**
- **ECS Fargate**: ~$30-100/month (depends on usage)
- **Application Load Balancer**: ~$20/month
- **Data Transfer**: ~$10-50/month (depends on traffic)
- **CloudWatch Logs**: ~$5-20/month

**Total**: ~$65-190/month for production workload

## Step 7: Security Notes

**Default security (automatically configured):**
- ✅ HTTPS encryption (if using custom domain)
- ✅ Network isolation with VPC
- ✅ Minimal port access (only required ports)
- ✅ IAM roles with least privilege
- ✅ Container security scanning

**Additional security (recommended):**
- Enable AWS WAF for DDoS protection
- Use AWS Secrets Manager for sensitive data
- Enable VPC Flow Logs for network monitoring

## Step 8: Deployment Commands

Once you have your AWS credentials configured:

```bash
# Navigate to deployment directory
cd server/aws

# Run the automated deployment
./deploy.sh --deployment-type ecs deploy

# OR with custom domain
./deploy.sh --deployment-type ecs \
  --domain-name "mediasoup.yourdomain.com" \
  --certificate-arn "arn:aws:acm:us-east-1:123456789:certificate/your-cert-id" \
  deploy
```

## Step 9: Access Your Application

After deployment:
1. The script will show you the load balancer URL
2. Your MediaSoup server will be accessible at: `http://your-alb-dns-name.amazonaws.com`
3. If using custom domain: `https://mediasoup.yourdomain.com`

## Step 10: Monitor Your Application

**CloudWatch (automatic):**
- Application logs: `/aws/ecs/mediasoup-production`
- Metrics: CPU, Memory, Network usage
- Alarms: Auto-scaling triggers

**Useful commands:**
```bash
# View service status
aws ecs describe-services --cluster mediasoup-production-cluster --services mediasoup-production-service

# View logs
aws logs tail /ecs/mediasoup-production --follow

# Scale manually
aws ecs update-service --cluster mediasoup-production-cluster --service mediasoup-production-service --desired-count 5
```

## Need Help?

**Common issues:**
- **AWS credentials**: Make sure `aws configure` worked
- **Docker not found**: Install Docker Desktop
- **Permission denied**: Check IAM permissions
- **Deployment failed**: Check CloudFormation console for details

**Support:**
- AWS Documentation: https://docs.aws.amazon.com/
- MediaSoup Documentation: https://mediasoup.org/
- GitHub Issues: Open an issue in this repository
