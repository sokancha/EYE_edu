# DAI-Ly

AI-based eye tracking learning focus analysis system.

## Overview

DAI-Ly analyzes user concentration during reading tests using webcam-based eye tracking.

The system collects gaze, head pose, and blink data with MediaPipe Face Landmarker, stores raw data in AWS S3, processes data through an Airflow pipeline, and generates AI-based focus reports using Amazon Bedrock Claude.

---

## Tech Stack

### Frontend

* React
* Vite
* Tailwind CSS
* MediaPipe
* AWS Amplify

### Backend / Pipeline

* Python
* Apache Airflow
* NumPy
* boto3

### Cloud

* AWS S3
* AWS Cognito
* AWS Lambda
* AWS ECS
* AWS ECR
* AWS Bedrock
* Docker

---

## Main Features

* Real-time eye tracking
* Gaze and head pose analysis
* Blink detection
* Learning focus scoring
* AI-generated focus reports
* AWS-based data pipeline

---

## System Flow

````text
Webcam
  ↓
MediaPipe Tracking
  ↓
S3 Raw Data Upload
  ↓
AWS Lambda Trigger
  ↓
Airflow DAG Execution
  ↓
Feature Extraction
  ↓
Amazon Bedrock Analysis
  ↓
AI Report Generation
````
---
## Airflow Pipeline

```text
load_s3_data
  ↓
extract_features
  ↓
invoke_bedrock
  ↓
save_report
```

---

## AWS Services

| Service | Purpose                     |
| ------- | --------------------------- |
| Cognito | Authentication              |
| S3      | Raw data and report storage |
| Lambda  | Event processing            |
| ECS     | Container execution         |
| ECR     | Docker image repository     |
| Bedrock | AI report generation        |

---

## Local Run

```bash
npm install
npm run dev
```

---

GitHub:
[https://github.com/chanminmun](https://github.com/chanminmun)
