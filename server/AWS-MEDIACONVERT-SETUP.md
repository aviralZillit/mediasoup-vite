# AWS MediaConvert Setup Guide

This guide explains how to set up AWS MediaConvert for high-quality video encoding after local FFmpeg composition.

## Architecture Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Individual     │     │    FFmpeg       │     │  composed.mp4   │
│  WebM streams   │ ──► │  (local fast)   │ ──► │  (fast encode)  │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                                                         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  high-quality   │     │  MediaConvert   │     │    S3 Bucket    │
│  .mp4 in S3     │ ◄── │  (AWS cloud)    │ ◄── │  raw-recordings │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## Step 1: Create S3 Bucket

```bash
aws s3 mb s3://your-mediasoup-recordings --region us-east-1
```

Or via AWS Console:
1. Go to S3 → Create bucket
2. Name: `your-mediasoup-recordings`
3. Region: Same as your MediaConvert region
4. Block all public access: ✅ (recommended)

## Step 2: Create IAM Role for MediaConvert

### Option A: Using AWS CLI

```bash
# Create the trust policy file
cat > mediaconvert-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "mediaconvert.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# Create the role
aws iam create-role \
  --role-name MediaConvertRole \
  --assume-role-policy-document file://mediaconvert-trust-policy.json

# Attach the policy for S3 access
cat > mediaconvert-s3-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectAcl",
        "s3:GetObjectTagging"
      ],
      "Resource": "arn:aws:s3:::your-mediasoup-recordings/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:PutObjectAcl",
        "s3:PutObjectTagging"
      ],
      "Resource": "arn:aws:s3:::your-mediasoup-recordings/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::your-mediasoup-recordings"
    }
  ]
}
EOF

# Create and attach the policy
aws iam put-role-policy \
  --role-name MediaConvertRole \
  --policy-name MediaConvertS3Access \
  --policy-document file://mediaconvert-s3-policy.json

# Get the role ARN (you'll need this!)
aws iam get-role --role-name MediaConvertRole --query 'Role.Arn' --output text
```

### Option B: Using AWS Console

1. Go to IAM → Roles → Create role
2. Trusted entity: AWS service → MediaConvert
3. Permissions: Create inline policy with:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectAcl",
        "s3:PutObject",
        "s3:PutObjectAcl",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::your-mediasoup-recordings",
        "arn:aws:s3:::your-mediasoup-recordings/*"
      ]
    }
  ]
}
```

4. Name: `MediaConvertRole`
5. Copy the Role ARN (looks like: `arn:aws:iam::123456789012:role/MediaConvertRole`)

## Step 3: IAM Permissions for Your Server

Your EC2 instance or server needs permissions to:
- Upload to S3
- Submit MediaConvert jobs
- Check job status

### If running on EC2 with IAM Role:

Attach this policy to your EC2 instance role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::your-mediasoup-recordings/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "mediaconvert:CreateJob",
        "mediaconvert:GetJob",
        "mediaconvert:DescribeEndpoints"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::YOUR_ACCOUNT_ID:role/MediaConvertRole"
    }
  ]
}
```

### If using IAM User (Access Keys):

Create an IAM user with the same permissions and use access keys.

## Step 4: Configure Environment Variables

Add these to your `.env` file or environment:

```bash
# Enable MediaConvert integration
USE_MEDIACONVERT=true

# AWS Region
AWS_REGION=us-east-1

# S3 bucket name
AWS_S3_BUCKET=your-mediasoup-recordings

# MediaConvert Role ARN (from Step 2)
MEDIACONVERT_ROLE_ARN=arn:aws:iam::123456789012:role/MediaConvertRole

# Optional: If using access keys instead of IAM role
# AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
# AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

## Step 5: Install Dependencies

```bash
cd server
npm install
```

This will install:
- `@aws-sdk/client-s3`
- `@aws-sdk/client-mediaconvert`
- `@aws-sdk/s3-request-presigner`

## Step 6: Test the Integration

1. Start your server with MediaConvert enabled:
```bash
USE_MEDIACONVERT=true npm start
```

2. Record a meeting

3. Stop recording - you should see logs like:
```
☁️  UPLOADING TO S3 & TRIGGERING MEDIACONVERT
Uploaded to S3: s3://your-mediasoup-recordings/raw-recordings/recording-xxx.mp4
✅ Job submitted successfully
   Job ID: 1234567890123-abcdef
   Output will be at: s3://your-mediasoup-recordings/encoded-recordings/roomId-timestamp/
```

4. Check job status in AWS Console → MediaConvert → Jobs

## Troubleshooting

### "Access Denied" when uploading to S3
- Check your server's IAM permissions include `s3:PutObject`
- Verify the bucket name is correct

### "AccessDeniedException" when creating MediaConvert job
- Ensure `iam:PassRole` permission for the MediaConvert role
- Verify `MEDIACONVERT_ROLE_ARN` is correct

### "Could not discover MediaConvert endpoint"
- Check your AWS credentials are valid
- Verify the region is correct

### Job fails with "Input file not found"
- Ensure MediaConvert role has `s3:GetObject` on the bucket
- Check the S3 URI format is correct (s3://bucket/key)

## Cost Estimation

- **S3 Storage**: ~$0.023/GB/month
- **MediaConvert On-Demand**: 
  - Basic tier: $0.0075/minute (SD)
  - Professional tier: $0.015/minute (HD 1080p)
- **S3 Transfer**: First 100GB/month free, then $0.09/GB

For a 1-hour HD recording: ~$0.90 (MediaConvert) + ~$0.02 (S3) = ~$0.92

## Disabling MediaConvert

To use only local FFmpeg composition (no cloud):

```bash
USE_MEDIACONVERT=false npm start
```

Or simply don't set the environment variable.
