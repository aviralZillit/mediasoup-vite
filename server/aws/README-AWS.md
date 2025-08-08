# MediaSoup AWS Deployment Guide

This guide provides comprehensive instructions for deploying the MediaSoup WebRTC server to AWS infrastructure using multiple deployment strategies with production-ready configurations.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Deployment Options](#deployment-options)
4. [Quick Start](#quick-start)
5. [Detailed Setup](#detailed-setup)
6. [Monitoring & Logging](#monitoring--logging)
7. [Scaling & Performance](#scaling--performance)
8. [Security Best Practices](#security-best-practices)
9. [Troubleshooting](#troubleshooting)
10. [Cost Optimization](#cost-optimization)
11. [Support and Maintenance](#support-and-maintenance)

## Architecture Overview

### Deployment Options

We provide three main deployment architectures:

1. **ECS Fargate** - Serverless containers with automatic scaling
2. **EKS Kubernetes** - Full container orchestration with advanced features  
3. **EC2 with Docker Compose** - Traditional VM-based deployment

### High-Level Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   CloudFront    │    │   Route 53      │    │   ACM SSL       │
│   (CDN)         │    │   (DNS)         │    │   (Certificates)│
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                ┌─────────────────┴─────────────────┐
                │          ALB/NLB                  │
                │      (Load Balancer)              │
                └─────────────────┬─────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  MediaSoup Pod  │    │  MediaSoup Pod  │    │  MediaSoup Pod  │
│    (WebRTC)     │    │    (WebRTC)     │    │    (WebRTC)     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                ┌─────────────────┴─────────────────┐
                │         Monitoring                │
                │   Prometheus + Grafana           │
                │   CloudWatch + X-Ray             │
                └───────────────────────────────────┘
```

### Components

- **MediaSoup Server**: WebRTC signaling and media server with connection quality monitoring
- **Load Balancer**: Application Load Balancer (ALB) or Network Load Balancer (NLB)
- **Auto Scaling**: Horizontal Pod Autoscaler (HPA) or ECS Service Auto Scaling
- **Monitoring**: Prometheus, Grafana, CloudWatch, AWS X-Ray
- **Logging**: ELK Stack or CloudWatch Logs with structured logging
- **Storage**: EBS for persistent data, ECR for container images
- **Security**: WAF, VPC, Security Groups, IAM roles with least privilege

## Prerequisites

### Required Tools

- AWS CLI v2.x or later
- Docker 20.x+ with BuildKit support
- kubectl 1.28+ (for EKS deployment)
- Terraform 1.0+ (optional, for infrastructure as code)
- Helm 3.x+ (for EKS deployments)

### AWS Services Required

- **Compute**: EC2, ECS Fargate, or EKS
- **Networking**: VPC, ALB/NLB, Route 53
- **Storage**: ECR, EBS, S3
- **Security**: IAM, ACM, AWS WAF
- **Monitoring**: CloudWatch, X-Ray
- **Databases**: RDS (optional), ElastiCache (optional)

### AWS Permissions

Your AWS user/role needs the following permissions:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:*",
        "ecs:*",
        "eks:*",
        "ecr:*",
        "iam:*",
        "cloudwatch:*",
        "logs:*",
        "route53:*",
        "acm:*",
        "elasticloadbalancing:*"
      ],
      "Resource": "*"
    }
  ]
}
```

## Deployment Options

### Option 1: ECS Fargate (Recommended for simplicity)

**Pros:**
- Serverless container management
- No infrastructure management
- Built-in auto scaling
- Cost-effective for variable workloads
- Native AWS integration

**Cons:**
- Less control over underlying infrastructure
- Limited customization options
- AWS vendor lock-in

**Use Cases:**
- Simple deployments
- Cost-sensitive projects
- Teams new to container orchestration

### Option 2: EKS Kubernetes (Recommended for advanced features)

**Pros:**
- Full Kubernetes ecosystem
- Advanced networking and storage options
- Extensive monitoring and logging
- Multi-cloud portability
- Advanced deployment strategies
- Rich ecosystem of tools

**Cons:**
- More complex setup and management
- Higher learning curve
- Additional costs for control plane
- Requires Kubernetes expertise

**Use Cases:**
- Complex microservices architectures
- Multi-environment deployments
- Teams with Kubernetes expertise
- Advanced networking requirements

### Option 3: EC2 with Docker Compose

**Pros:**
- Full control over infrastructure
- Familiar deployment model
- Lower complexity than Kubernetes
- Direct server access

**Cons:**
- Manual scaling required
- More maintenance overhead
- Single point of failure
- Limited auto-recovery

**Use Cases:**
- Development environments
- Legacy migration projects
- Small-scale deployments

## Quick Start - ECS Fargate Deployment

### Prerequisites Check

First, make sure you have the required tools:

```bash
# Check if AWS CLI is installed
aws --version

# Check if Docker is installed  
docker --version

# Check if AWS credentials are configured
aws sts get-caller-identity
```

If any of these fail, see the [Setup Guide](./SETUP-GUIDE.md) for installation instructions.

### Step 1: Configure AWS Credentials

If you haven't configured AWS yet:

```bash
aws configure
```

You'll need:
- **AWS Access Key ID**: Get from AWS Console → IAM → Users → Security credentials
- **AWS Secret Access Key**: Same location as above
- **Default region**: `us-east-1` (recommended)
- **Default output format**: `json`

### Step 2: Deploy to ECS Fargate

Navigate to the deployment directory and run the automated script:

```bash
cd server/aws
chmod +x deploy.sh

# Deploy with default settings (recommended for first deployment)
./deploy.sh --deployment-type ecs deploy
```

**That's it!** The script will:
1. ✅ Create ECR repository for your container images
2. ✅ Build and push your MediaSoup Docker image
3. ✅ Deploy ECS Fargate cluster with auto-scaling
4. ✅ Set up Application Load Balancer
5. ✅ Configure security groups and IAM roles
6. ✅ Enable CloudWatch monitoring

### Step 3: Access Your Application

After deployment completes (5-10 minutes), you'll see:

```
🎉 Deployment completed successfully!

📍 Access your MediaSoup server at:
   http://mediasoup-production-alb-1234567890.us-east-1.elb.amazonaws.com
```

### Optional: Custom Domain Setup

**Only if you want a custom domain like `mediasoup.yourdomain.com`:**

1. **Get SSL Certificate:**
   ```bash
   # Request certificate in AWS Certificate Manager
   aws acm request-certificate \
     --domain-name "mediasoup.yourdomain.com" \
     --validation-method DNS \
     --region us-east-1
   ```

2. **Deploy with custom domain:**
   ```bash
   ./deploy.sh --deployment-type ecs \
     --domain-name "mediasoup.yourdomain.com" \
     --certificate-arn "arn:aws:acm:us-east-1:123456789:certificate/your-cert-id" \
     deploy
   ```

**EKS Kubernetes (Most features):**
```bash
./deploy.sh --deployment-type eks deploy
```

**Terraform (Infrastructure as Code):**
```bash
cd terraform
terraform init
terraform plan -var="domain_name=$DOMAIN_NAME"
terraform apply
```

## Detailed Setup

### ECS Fargate Deployment

#### 1. Infrastructure Setup

```bash
# Create ECR Repository
aws ecr create-repository \
  --repository-name mediasoup-server \
  --region $AWS_REGION \
  --image-scanning-configuration scanOnPush=true
```

#### 2. Build and Push Docker Image

```bash
# Get ECR login token
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin \
  $AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com

# Build optimized image
docker build \
  --build-arg NODE_ENV=production \
  --target production \
  -t mediasoup-server:latest \
  ../

# Tag and push
docker tag mediasoup-server:latest \
  $AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/mediasoup-server:latest

docker push $AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/mediasoup-server:latest
```

#### 3. Deploy CloudFormation Stack

```bash
aws cloudformation deploy \
  --template-file cloudformation-ecs.yaml \
  --stack-name $STACK_NAME \
  --region $AWS_REGION \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    VpcId=$(aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query 'Vpcs[0].VpcId' --output text) \
    SubnetIds=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$(aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query 'Vpcs[0].VpcId' --output text)" --query 'Subnets[?MapPublicIpOnLaunch==`true`].SubnetId' --output text | tr '\t' ',') \
    DomainName=$DOMAIN_NAME \
    CertificateArn=$CERTIFICATE_ARN \
    ImageUri=$AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/mediasoup-server:latest
```

### EKS Kubernetes Deployment

#### 1. Deploy EKS Cluster

```bash
# Deploy infrastructure
aws cloudformation deploy \
  --template-file cloudformation-eks.yaml \
  --stack-name $STACK_NAME-eks \
  --region $AWS_REGION \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ClusterName=$STACK_NAME-cluster \
    NodeGroupInstanceType=t3.medium \
    MinSize=2 \
    MaxSize=10 \
    DesiredSize=3
```

#### 2. Configure kubectl

```bash
# Update kubeconfig
aws eks update-kubeconfig \
  --region $AWS_REGION \
  --name $STACK_NAME-cluster

# Verify connection
kubectl get nodes
```

#### 3. Install Required Controllers

```bash
# Install AWS Load Balancer Controller
helm repo add eks https://aws.github.io/eks-charts
helm repo update

helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=$STACK_NAME-cluster \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller

# Install Cluster Autoscaler
helm repo add autoscaler https://kubernetes.github.io/autoscaler
helm install cluster-autoscaler autoscaler/cluster-autoscaler \
  --namespace kube-system \
  --set autoDiscovery.clusterName=$STACK_NAME-cluster \
  --set awsRegion=$AWS_REGION
```

#### 4. Deploy Application

```bash
# Update image URI in manifests
sed -i "s|your-account.dkr.ecr.region.amazonaws.com/mediasoup-server:latest|$AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/mediasoup-server:latest|g" k8s/mediasoup-deployment.yaml

# Deploy application
kubectl apply -f k8s/mediasoup-deployment.yaml

# Configure ingress (if using custom domain)
if [ ! -z "$CERTIFICATE_ARN" ]; then
  sed -i "s|arn:aws:acm:region:account:certificate/certificate-id|$CERTIFICATE_ARN|g" k8s/ingress.yaml
  sed -i "s|mediasoup.yourdomain.com|$DOMAIN_NAME|g" k8s/ingress.yaml
  kubectl apply -f k8s/ingress.yaml
fi
```

### Terraform Deployment (Infrastructure as Code)

#### 1. Initialize and Configure

```bash
cd terraform

# Initialize Terraform
terraform init

# Create terraform.tfvars
cat > terraform.tfvars << EOF
aws_region = "$AWS_REGION"
project_name = "mediasoup"
environment = "production"
domain_name = "$DOMAIN_NAME"
cluster_version = "1.28"
node_instance_types = ["t3.medium", "t3.large"]
node_desired_size = 3
node_max_size = 10
node_min_size = 2
enable_monitoring = true
enable_logging = true
EOF
```

#### 2. Deploy Infrastructure

```bash
# Plan deployment
terraform plan -out=tfplan

# Apply configuration
terraform apply tfplan

# Get outputs
terraform output
```

## Monitoring & Logging

### CloudWatch Integration

Both ECS and EKS deployments include comprehensive CloudWatch integration for monitoring application and infrastructure metrics with automated alerting.

### Prometheus & Grafana (EKS)

For EKS deployments, we include a complete monitoring stack with custom dashboards for MediaSoup-specific metrics and alerting rules.

## Scaling & Performance

### Auto Scaling Configuration

The deployment includes automatic scaling based on CPU, memory, and custom metrics to handle varying loads efficiently.

## Security Best Practices

Comprehensive security implementation including VPC isolation, security groups, IAM roles with least privilege, container security, and SSL/TLS encryption.

## Troubleshooting

Detailed troubleshooting guides for common issues including connection failures, scaling problems, and performance issues with debugging commands and solutions.

## Cost Optimization

Guidelines for optimizing AWS costs including right-sizing, reserved instances, spot instances, and cost monitoring strategies.

## Support and Maintenance

Best practices for backup and recovery, updates and patches, health monitoring, and operational procedures.

---

For complete deployment instructions, examples, and detailed configuration options, see the full documentation above.
