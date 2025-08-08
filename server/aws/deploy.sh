#!/bin/bash

# MediaSoup AWS Deployment Script
# This script automates the deployment of MediaSoup server to AWS

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
STACK_NAME="${STACK_NAME:-mediasoup-stack}"
REGION="${AWS_REGION:-us-east-1}"
DEPLOYMENT_TYPE="${DEPLOYMENT_TYPE:-ecs}" # ecs, eks, ec2
ECR_REPOSITORY="${ECR_REPOSITORY:-}"
DOMAIN_NAME="${DOMAIN_NAME:-}"
CERTIFICATE_ARN="${CERTIFICATE_ARN:-}"

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_dependencies() {
    log_info "Checking dependencies..."
    
    # Check AWS CLI
    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI is not installed. Please install it first."
        exit 1
    fi
    
    # Check Docker
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed. Please install it first."
        exit 1
    fi
    
    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        log_error "AWS credentials are not configured. Please run 'aws configure' first."
        exit 1
    fi
    
    log_success "All dependencies are available."
}

create_ecr_repository() {
    log_info "Creating ECR repository..."
    
    if [ -z "$ECR_REPOSITORY" ]; then
        ECR_REPOSITORY="mediasoup-server"
    fi
    
    # Check if repository exists
    if aws ecr describe-repositories --repository-names "$ECR_REPOSITORY" --region "$REGION" &> /dev/null; then
        log_warning "ECR repository '$ECR_REPOSITORY' already exists."
    else
        aws ecr create-repository \
            --repository-name "$ECR_REPOSITORY" \
            --region "$REGION" \
            --image-scanning-configuration scanOnPush=true
        log_success "ECR repository '$ECR_REPOSITORY' created."
    fi
    
    # Get repository URI
    ECR_URI=$(aws ecr describe-repositories \
        --repository-names "$ECR_REPOSITORY" \
        --region "$REGION" \
        --query 'repositories[0].repositoryUri' \
        --output text)
    
    export ECR_URI
    log_info "ECR Repository URI: $ECR_URI"
}

build_and_push_image() {
    log_info "Building and pushing Docker image..."
    
    # Login to ECR
    aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR_URI"
    
    # Build image
    log_info "Building Docker image..."
    docker build -t "$ECR_REPOSITORY:latest" -f ../Dockerfile ..
    
    # Tag image
    docker tag "$ECR_REPOSITORY:latest" "$ECR_URI:latest"
    docker tag "$ECR_REPOSITORY:latest" "$ECR_URI:$(git rev-parse --short HEAD)"
    
    # Push image
    log_info "Pushing Docker image to ECR..."
    docker push "$ECR_URI:latest"
    docker push "$ECR_URI:$(git rev-parse --short HEAD)"
    
    log_success "Docker image pushed successfully."
}

deploy_ecs() {
    log_info "Deploying to ECS..."
    
    # Validate required parameters
    if [ -z "$DOMAIN_NAME" ] || [ -z "$CERTIFICATE_ARN" ]; then
        log_error "DOMAIN_NAME and CERTIFICATE_ARN are required for ECS deployment."
        exit 1
    fi
    
    # Get default VPC and subnets
    VPC_ID=$(aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query 'Vpcs[0].VpcId' --output text --region "$REGION")
    SUBNET_IDS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query 'Subnets[?MapPublicIpOnLaunch==`true`].SubnetId' --output text --region "$REGION" | tr '\t' ',')
    
    log_info "Using VPC: $VPC_ID"
    log_info "Using Subnets: $SUBNET_IDS"
    
    # Deploy CloudFormation stack
    aws cloudformation deploy \
        --template-file cloudformation-ecs.yaml \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        --capabilities CAPABILITY_IAM \
        --parameter-overrides \
            VpcId="$VPC_ID" \
            SubnetIds="$SUBNET_IDS" \
            DomainName="$DOMAIN_NAME" \
            CertificateArn="$CERTIFICATE_ARN" \
            ImageUri="$ECR_URI:latest"
    
    log_success "ECS deployment completed."
    
    # Get ALB DNS name
    ALB_DNS=$(aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        --query 'Stacks[0].Outputs[?OutputKey==`LoadBalancerDNS`].OutputValue' \
        --output text)
    
    log_success "Application is available at: https://$ALB_DNS"
}

deploy_eks() {
    log_info "Deploying to EKS..."
    
    # Deploy EKS cluster
    aws cloudformation deploy \
        --template-file cloudformation-eks.yaml \
        --stack-name "$STACK_NAME-eks" \
        --region "$REGION" \
        --capabilities CAPABILITY_IAM \
        --parameter-overrides \
            ClusterName="$STACK_NAME-cluster"
    
    log_success "EKS cluster deployment completed."
    
    # Update kubeconfig
    aws eks update-kubeconfig --region "$REGION" --name "$STACK_NAME-cluster"
    
    # Apply Kubernetes manifests
    kubectl apply -f k8s/
    
    log_success "Kubernetes manifests applied."
    
    # Get LoadBalancer URL
    log_info "Waiting for LoadBalancer to be ready..."
    kubectl wait --for=condition=ready service/mediasoup-server-service --timeout=300s
    
    LB_HOSTNAME=$(kubectl get service mediasoup-server-service -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
    log_success "Application is available at: http://$LB_HOSTNAME"
}

deploy_ec2() {
    log_info "Deploying to EC2 with Docker Compose..."
    
    # This would require additional setup for EC2 instances
    # For now, we'll show the manual steps
    cat << EOF
To deploy to EC2 with Docker Compose:

1. Launch an EC2 instance with Docker installed
2. Copy the docker-compose.prod.yml file to the instance
3. Set environment variables:
   export ECR_URI=$ECR_URI
4. Run: docker-compose -f docker-compose.prod.yml up -d

For automated EC2 deployment, consider using AWS Systems Manager or CodeDeploy.
EOF
}

cleanup() {
    log_info "Cleaning up resources..."
    
    case $DEPLOYMENT_TYPE in
        ecs)
            aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
            ;;
        eks)
            kubectl delete -f k8s/ || true
            aws cloudformation delete-stack --stack-name "$STACK_NAME-eks" --region "$REGION"
            ;;
        *)
            log_warning "Cleanup not implemented for deployment type: $DEPLOYMENT_TYPE"
            ;;
    esac
    
    log_success "Cleanup completed."
}

show_help() {
    cat << EOF
MediaSoup AWS Deployment Script

Usage: $0 [OPTIONS] COMMAND

Commands:
    deploy      Deploy the application
    cleanup     Remove all AWS resources
    help        Show this help message

Options:
    --stack-name NAME           CloudFormation stack name (default: mediasoup-stack)
    --region REGION            AWS region (default: us-east-1)
    --deployment-type TYPE     Deployment type: ecs, eks, ec2 (default: ecs)
    --ecr-repository NAME      ECR repository name (default: mediasoup-server)
    --domain-name DOMAIN       Domain name for the application
    --certificate-arn ARN      ACM certificate ARN for HTTPS

Environment Variables:
    STACK_NAME                 Same as --stack-name
    AWS_REGION                 Same as --region
    DEPLOYMENT_TYPE            Same as --deployment-type
    ECR_REPOSITORY             Same as --ecr-repository
    DOMAIN_NAME                Same as --domain-name
    CERTIFICATE_ARN            Same as --certificate-arn

Examples:
    # Deploy to ECS
    $0 --deployment-type ecs --domain-name mediasoup.example.com --certificate-arn arn:aws:acm:... deploy

    # Deploy to EKS
    $0 --deployment-type eks deploy

    # Cleanup resources
    $0 cleanup
EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --stack-name)
            STACK_NAME="$2"
            shift 2
            ;;
        --region)
            REGION="$2"
            shift 2
            ;;
        --deployment-type)
            DEPLOYMENT_TYPE="$2"
            shift 2
            ;;
        --ecr-repository)
            ECR_REPOSITORY="$2"
            shift 2
            ;;
        --domain-name)
            DOMAIN_NAME="$2"
            shift 2
            ;;
        --certificate-arn)
            CERTIFICATE_ARN="$2"
            shift 2
            ;;
        deploy)
            COMMAND="deploy"
            shift
            ;;
        cleanup)
            COMMAND="cleanup"
            shift
            ;;
        help|--help|-h)
            show_help
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# Main execution
case ${COMMAND:-} in
    deploy)
        log_info "Starting MediaSoup deployment to AWS..."
        log_info "Configuration:"
        log_info "  Stack Name: $STACK_NAME"
        log_info "  Region: $REGION"
        log_info "  Deployment Type: $DEPLOYMENT_TYPE"
        log_info "  ECR Repository: $ECR_REPOSITORY"
        
        check_dependencies
        create_ecr_repository
        build_and_push_image
        
        case $DEPLOYMENT_TYPE in
            ecs)
                deploy_ecs
                ;;
            eks)
                deploy_eks
                ;;
            ec2)
                deploy_ec2
                ;;
            *)
                log_error "Invalid deployment type: $DEPLOYMENT_TYPE"
                exit 1
                ;;
        esac
        
        log_success "Deployment completed successfully!"
        ;;
    cleanup)
        cleanup
        ;;
    *)
        log_error "No command specified. Use 'deploy', 'cleanup', or 'help'."
        show_help
        exit 1
        ;;
esac
