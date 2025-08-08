variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "production"
}

variable "project_name" {
  description = "Project name"
  type        = string
  default     = "mediasoup"
}

variable "cluster_version" {
  description = "Kubernetes cluster version"
  type        = string
  default     = "1.28"
}

variable "node_instance_types" {
  description = "Instance types for EKS node group"
  type        = list(string)
  default     = ["t3.medium", "t3.large"]
}

variable "node_desired_size" {
  description = "Desired number of nodes"
  type        = number
  default     = 3
}

variable "node_max_size" {
  description = "Maximum number of nodes"
  type        = number
  default     = 10
}

variable "node_min_size" {
  description = "Minimum number of nodes"
  type        = number
  default     = 2
}

variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "domain_name" {
  description = "Domain name for the application"
  type        = string
  default     = ""
}

variable "enable_monitoring" {
  description = "Enable monitoring stack (Prometheus/Grafana)"
  type        = bool
  default     = true
}

variable "enable_logging" {
  description = "Enable centralized logging (ELK stack)"
  type        = bool
  default     = true
}

variable "ecr_repository_name" {
  description = "ECR repository name"
  type        = string
  default     = "mediasoup-server"
}

variable "app_replicas" {
  description = "Number of application replicas"
  type        = number
  default     = 3
}

variable "app_cpu_request" {
  description = "CPU request for application pods"
  type        = string
  default     = "500m"
}

variable "app_memory_request" {
  description = "Memory request for application pods"
  type        = string
  default     = "1Gi"
}

variable "app_cpu_limit" {
  description = "CPU limit for application pods"
  type        = string
  default     = "1000m"
}

variable "app_memory_limit" {
  description = "Memory limit for application pods"
  type        = string
  default     = "2Gi"
}

variable "enable_ssl" {
  description = "Enable SSL/TLS"
  type        = bool
  default     = true
}

variable "ssl_certificate_arn" {
  description = "ACM certificate ARN for SSL"
  type        = string
  default     = ""
}
