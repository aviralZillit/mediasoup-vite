# Data sources
data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

# VPC Module
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  
  name = "${local.name}-vpc"
  cidr = var.vpc_cidr
  
  azs             = slice(data.aws_availability_zones.available.names, 0, 3)
  private_subnets = [for k, v in slice(data.aws_availability_zones.available.names, 0, 3) : cidrsubnet(var.vpc_cidr, 4, k)]
  public_subnets  = [for k, v in slice(data.aws_availability_zones.available.names, 0, 3) : cidrsubnet(var.vpc_cidr, 4, k + 4)]
  
  enable_nat_gateway   = true
  single_nat_gateway   = false
  enable_dns_hostnames = true
  enable_dns_support   = true
  
  # Enable flow logs
  enable_flow_log                      = true
  create_flow_log_cloudwatch_iam_role  = true
  create_flow_log_cloudwatch_log_group = true
  
  # Kubernetes tags
  public_subnet_tags = {
    "kubernetes.io/role/elb" = "1"
  }
  
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = "1"
  }
  
  tags = local.tags
}

# ECR Repository
resource "aws_ecr_repository" "mediasoup" {
  name                 = var.ecr_repository_name
  image_tag_mutability = "MUTABLE"
  
  image_scanning_configuration {
    scan_on_push = true
  }
  
  encryption_configuration {
    encryption_type = "AES256"
  }
  
  tags = local.tags
}

resource "aws_ecr_lifecycle_policy" "mediasoup" {
  repository = aws_ecr_repository.mediasoup.name
  
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["latest"]
          countType     = "imageCountMoreThan"
          countNumber   = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# EKS Module
module "eks" {
  source = "terraform-aws-modules/eks/aws"
  
  cluster_name    = "${local.name}-cluster"
  cluster_version = var.cluster_version
  
  vpc_id                         = module.vpc.vpc_id
  subnet_ids                     = module.vpc.private_subnets
  cluster_endpoint_public_access = true
  
  # Enable cluster logging
  cluster_enabled_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]
  
  # EKS Add-ons
  cluster_addons = {
    coredns = {
      most_recent = true
    }
    kube-proxy = {
      most_recent = true
    }
    vpc-cni = {
      most_recent = true
    }
    aws-ebs-csi-driver = {
      most_recent = true
    }
  }
  
  # Node groups
  eks_managed_node_groups = {
    main = {
      name           = "${local.name}-nodes"
      instance_types = var.node_instance_types
      
      min_size     = var.node_min_size
      max_size     = var.node_max_size
      desired_size = var.node_desired_size
      
      capacity_type = "ON_DEMAND"
      
      # Enable managed node group capacity provider
      use_custom_launch_template = false
      
      disk_size = 100
      disk_type = "gp3"
      
      # Remote access via Systems Manager
      remote_access = {
        ec2_ssh_key               = null
        source_security_group_ids = []
      }
      
      labels = {
        Environment = var.environment
        NodeGroup   = "main"
      }
      
      tags = local.tags
    }
  }
  
  # OIDC Identity provider
  cluster_identity_providers = {
    sts = {
      client_id = "sts.amazonaws.com"
    }
  }
  
  tags = local.tags
}

# AWS Load Balancer Controller
module "load_balancer_controller_irsa_role" {
  source = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  
  role_name = "aws-load-balancer-controller"
  
  attach_load_balancer_controller_policy = true
  
  oidc_providers = {
    ex = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:aws-load-balancer-controller"]
    }
  }
  
  tags = local.tags
}

resource "helm_release" "aws_load_balancer_controller" {
  name       = "aws-load-balancer-controller"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  namespace  = "kube-system"
  version    = "1.6.2"
  
  set {
    name  = "clusterName"
    value = module.eks.cluster_name
  }
  
  set {
    name  = "serviceAccount.create"
    value = "true"
  }
  
  set {
    name  = "serviceAccount.name"
    value = "aws-load-balancer-controller"
  }
  
  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.load_balancer_controller_irsa_role.iam_role_arn
  }
  
  depends_on = [module.eks]
}

# Monitoring (Prometheus & Grafana)
resource "helm_release" "prometheus" {
  count = var.enable_monitoring ? 1 : 0
  
  name       = "prometheus"
  repository = "https://prometheus-community.github.io/helm-charts"
  chart      = "kube-prometheus-stack"
  namespace  = "monitoring"
  version    = "51.2.0"
  
  create_namespace = true
  
  values = [
    file("${path.module}/helm-values/prometheus-values.yaml")
  ]
  
  depends_on = [module.eks]
}

# EBS CSI Driver
module "ebs_csi_driver_irsa" {
  source = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  
  role_name = "ebs-csi-driver"
  
  attach_ebs_csi_policy = true
  
  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:ebs-csi-controller-sa"]
    }
  }
  
  tags = local.tags
}

# Cluster Autoscaler
module "cluster_autoscaler_irsa_role" {
  source = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  
  role_name = "cluster-autoscaler"
  
  attach_cluster_autoscaler_policy = true
  cluster_autoscaler_cluster_names = [module.eks.cluster_name]
  
  oidc_providers = {
    ex = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:cluster-autoscaler"]
    }
  }
  
  tags = local.tags
}

resource "helm_release" "cluster_autoscaler" {
  name       = "cluster-autoscaler"
  repository = "https://kubernetes.github.io/autoscaler"
  chart      = "cluster-autoscaler"
  namespace  = "kube-system"
  version    = "9.21.0"
  
  set {
    name  = "autoDiscovery.clusterName"
    value = module.eks.cluster_name
  }
  
  set {
    name  = "awsRegion"
    value = var.aws_region
  }
  
  set {
    name  = "rbac.serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.cluster_autoscaler_irsa_role.iam_role_arn
  }
  
  depends_on = [module.eks]
}

# ACM Certificate (if domain provided)
resource "aws_acm_certificate" "main" {
  count = var.domain_name != "" ? 1 : 0
  
  domain_name       = var.domain_name
  validation_method = "DNS"
  
  lifecycle {
    create_before_destroy = true
  }
  
  tags = local.tags
}

# CloudWatch Log Groups
resource "aws_cloudwatch_log_group" "eks_cluster" {
  name              = "/aws/eks/${module.eks.cluster_name}/cluster"
  retention_in_days = 7
  
  tags = local.tags
}

resource "aws_cloudwatch_log_group" "mediasoup_app" {
  name              = "/aws/eks/${module.eks.cluster_name}/mediasoup"
  retention_in_days = 7
  
  tags = local.tags
}
