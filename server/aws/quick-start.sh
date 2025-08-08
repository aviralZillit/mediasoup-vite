#!/bin/bash

# MediaSoup AWS Fargate - Quick Start Guide
# This script will guide you through deploying MediaSoup to AWS Fargate

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "🚀 MediaSoup AWS Fargate Deployment"
echo "===================================="
echo -e "${NC}"

# Function to check prerequisites
check_prerequisites() {
    echo -e "${BLUE}Step 1: Checking Prerequisites...${NC}"
    
    # Check AWS CLI
    if ! command -v aws &> /dev/null; then
        echo -e "${RED}❌ AWS CLI not found${NC}"
        echo "Please install AWS CLI v2:"
        echo "  macOS: curl 'https://awscli.amazonaws.com/AWSCLIV2.pkg' -o 'AWSCLIV2.pkg' && sudo installer -pkg AWSCLIV2.pkg -target /"
        echo "  Linux: curl 'https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip' -o 'awscliv2.zip' && unzip awscliv2.zip && sudo ./aws/install"
        exit 1
    else
        echo -e "${GREEN}✅ AWS CLI found: $(aws --version)${NC}"
    fi
    
    # Check Docker
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}❌ Docker not found${NC}"
        echo "Please install Docker Desktop from https://docker.com"
        exit 1
    else
        echo -e "${GREEN}✅ Docker found: $(docker --version)${NC}"
    fi
    
    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        echo -e "${YELLOW}⚠️  AWS credentials not configured${NC}"
        echo ""
        echo "Please configure AWS credentials:"
        echo "1. Go to AWS Console → IAM → Users → [Your User] → Security credentials"
        echo "2. Create access key for Command Line Interface (CLI)"
        echo "3. Run: aws configure"
        echo "   - AWS Access Key ID: [Your access key]"
        echo "   - AWS Secret Access Key: [Your secret key]"
        echo "   - Default region name: us-east-1"
        echo "   - Default output format: json"
        echo ""
        read -p "Press Enter after configuring AWS credentials..."
        
        if ! aws sts get-caller-identity &> /dev/null; then
            echo -e "${RED}❌ AWS credentials still not working${NC}"
            exit 1
        fi
    fi
    
    AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
    AWS_REGION=$(aws configure get region || echo "us-east-1")
    
    echo -e "${GREEN}✅ AWS credentials configured${NC}"
    echo "   Account: $AWS_ACCOUNT"
    echo "   Region: $AWS_REGION"
    echo ""
}

# Function to deploy
deploy_mediasoup() {
    echo -e "${BLUE}Step 2: Deploying MediaSoup to AWS Fargate...${NC}"
    echo ""
    
    # Set configuration
    export AWS_REGION="${AWS_REGION:-us-east-1}"
    export STACK_NAME="mediasoup-production"
    export ECR_REPOSITORY="mediasoup-server"
    
    echo "Configuration:"
    echo "  Stack Name: $STACK_NAME"
    echo "  Region: $AWS_REGION"
    echo "  ECR Repository: $ECR_REPOSITORY"
    echo ""
    
    # Create ECR repository
    echo -e "${BLUE}Creating ECR repository...${NC}"
    if aws ecr describe-repositories --repository-names "$ECR_REPOSITORY" --region "$AWS_REGION" &> /dev/null; then
        echo -e "${GREEN}✅ ECR repository already exists${NC}"
    else
        aws ecr create-repository \
            --repository-name "$ECR_REPOSITORY" \
            --region "$AWS_REGION" \
            --image-scanning-configuration scanOnPush=true > /dev/null
        echo -e "${GREEN}✅ ECR repository created${NC}"
    fi
    
    # Get ECR URI
    ECR_URI=$(aws ecr describe-repositories \
        --repository-names "$ECR_REPOSITORY" \
        --region "$AWS_REGION" \
        --query 'repositories[0].repositoryUri' \
        --output text)
    
    echo "ECR URI: $ECR_URI"
    echo ""
    
    # Build and push Docker image
    echo -e "${BLUE}Building and pushing Docker image...${NC}"
    
    # Login to ECR
    aws ecr get-login-password --region "$AWS_REGION" | \
        docker login --username AWS --password-stdin "$ECR_URI" > /dev/null
    
    # Build image
    echo "Building Docker image..."
    cd ../
    docker build -t "$ECR_REPOSITORY:latest" -f Dockerfile . > /dev/null
    
    # Tag and push
    docker tag "$ECR_REPOSITORY:latest" "$ECR_URI:latest" > /dev/null
    docker tag "$ECR_REPOSITORY:latest" "$ECR_URI:$(date +%Y%m%d-%H%M%S)" > /dev/null
    
    echo "Pushing Docker image..."
    docker push "$ECR_URI:latest" > /dev/null
    docker push "$ECR_URI:$(date +%Y%m%d-%H%M%S)" > /dev/null
    
    echo -e "${GREEN}✅ Docker image pushed successfully${NC}"
    cd aws/
    echo ""
    
    # Deploy CloudFormation stack
    echo -e "${BLUE}Deploying CloudFormation stack...${NC}"
    echo "This may take 5-10 minutes..."
    
    # Get default VPC and subnets
    VPC_ID=$(aws ec2 describe-vpcs \
        --filters "Name=isDefault,Values=true" \
        --query 'Vpcs[0].VpcId' \
        --output text \
        --region "$AWS_REGION")
    
    SUBNET_IDS=$(aws ec2 describe-subnets \
        --filters "Name=vpc-id,Values=$VPC_ID" \
        --query 'Subnets[?MapPublicIpOnLaunch==`true`].SubnetId' \
        --output text \
        --region "$AWS_REGION" | tr '\t' ',')
    
    echo "Using VPC: $VPC_ID"
    echo "Using Subnets: $SUBNET_IDS"
    echo ""
    
    # Deploy stack
    aws cloudformation deploy \
        --template-file cloudformation-ecs.yaml \
        --stack-name "$STACK_NAME" \
        --region "$AWS_REGION" \
        --capabilities CAPABILITY_IAM \
        --parameter-overrides \
            VpcId="$VPC_ID" \
            SubnetIds="$SUBNET_IDS" \
            ImageUri="$ECR_URI:latest"
    
    echo -e "${GREEN}✅ CloudFormation stack deployed${NC}"
    echo ""
}

# Function to show deployment info
show_deployment_info() {
    echo -e "${BLUE}Step 3: Deployment Information${NC}"
    echo ""
    
    # Get load balancer DNS
    ALB_DNS=$(aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$AWS_REGION" \
        --query 'Stacks[0].Outputs[?OutputKey==`LoadBalancerDNS`].OutputValue' \
        --output text)
    
    echo -e "${GREEN}🎉 Deployment completed successfully!${NC}"
    echo ""
    echo -e "${BLUE}📍 Access your MediaSoup server at:${NC}"
    echo "   http://$ALB_DNS"
    echo ""
    echo -e "${BLUE}🔧 Useful management commands:${NC}"
    echo ""
    echo "# View service status:"
    echo "aws ecs describe-services --cluster ${STACK_NAME}-cluster --services ${STACK_NAME}-service --region $AWS_REGION"
    echo ""
    echo "# View application logs:"
    echo "aws logs tail /ecs/${STACK_NAME} --follow --region $AWS_REGION"
    echo ""
    echo "# Scale service (change desired count):"
    echo "aws ecs update-service --cluster ${STACK_NAME}-cluster --service ${STACK_NAME}-service --desired-count 3 --region $AWS_REGION"
    echo ""
    echo "# Delete deployment:"
    echo "aws cloudformation delete-stack --stack-name $STACK_NAME --region $AWS_REGION"
    echo ""
    echo -e "${BLUE}💰 Estimated monthly cost: \$50-150 (depends on usage)${NC}"
    echo ""
    echo -e "${BLUE}📚 Next steps:${NC}"
    echo "1. Test your MediaSoup server at the URL above"
    echo "2. Configure your frontend app to connect to this server"
    echo "3. Set up custom domain (optional) - see README-AWS.md"
    echo "4. Configure monitoring alerts in CloudWatch"
    echo ""
}

# Main execution
main() {
    check_prerequisites
    deploy_mediasoup
    show_deployment_info
}

# Handle script arguments
case "${1:-}" in
    "help"|"--help"|"-h")
        echo "MediaSoup AWS Fargate Quick Start"
        echo ""
        echo "Usage: $0 [command]"
        echo ""
        echo "Commands:"
        echo "  (no args)  Run full deployment"
        echo "  help       Show this help"
        echo "  check      Check prerequisites only"
        echo ""
        echo "This script will:"
        echo "1. Check AWS CLI, Docker, and credentials"
        echo "2. Create ECR repository and build Docker image"
        echo "3. Deploy ECS Fargate infrastructure"
        echo "4. Provide access URL and management commands"
        echo ""
        ;;
    "check")
        check_prerequisites
        ;;
    *)
        main
        ;;
esac
