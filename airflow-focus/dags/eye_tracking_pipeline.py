from airflow import DAG
from airflow.operators.python import PythonOperator
from datetime import datetime
import json
import boto3
import numpy as np

S3_RAW_BUCKET = "YOUR_RAW_BUCKET"
S3_REPORT_BUCKET = "YOUR_REPORT_BUCKET"
BEDROCK_MODEL_ID = "YOUR_BEDROCK_MODEL_ID"
REGION = "YOUR_REGION"


def load_s3_data(**context):
    conf = context["dag_run"].conf or {}

    user_id = conf.get("user_id")
    test_id = conf.get("test_id")

    if not user_id or not test_id:
        raise ValueError("user_id and test_id are required in dag_run.conf")

    s3 = boto3.client("s3", region_name=REGION)
    base_key = f"raw/{user_id}/{test_id}"

    calib_obj = s3.get_object(
        Bucket=S3_RAW_BUCKET,
        Key=f"{base_key}/calibration/calibration.json"
    )
    calibration = json.loads(calib_obj["Body"].read())

    test_obj = s3.get_object(
        Bucket=S3_RAW_BUCKET,
        Key=f"{base_key}/test/gaze_data.json"
    )
    test_data = json.loads(test_obj["Body"].read())

    return {
        "user_id": user_id,
        "test_id": test_id,
        "calibration_profile": calibration["calibration_profile"],
        "timeline_log": test_data["timeline_log"],
        "duration_minutes": test_data["test_info"]["duration_minutes"]
    }


def is_escape_frame(
    frame,
    gaze_x_min,
    gaze_x_max,
    gaze_y_min,
    gaze_y_max,
    pose_x_min,
    pose_x_max,
    pose_y_min,
    pose_y_max
):
    if not frame.get("face_detected", False):
        return True

    if frame.get("is_blinking", False):
        return False

    gx = frame.get("gaze_x")
    gy = frame.get("gaze_y")
    px = frame.get("pose_x")
    py = frame.get("pose_y")

    if gx is None or gy is None:
        return False

    gaze_out = (
        gx < gaze_x_min or gx > gaze_x_max or
        gy < gaze_y_min or gy > gaze_y_max
    )

    pose_out = False

    if px is not None and py is not None:
        pose_out = (
            px < pose_x_min or px > pose_x_max or
            py < pose_y_min or py > pose_y_max
        )
    elif px is not None:
        pose_out = px < pose_x_min or px > pose_x_max

    # 얼굴이 확실히 벗어나면 이탈
    if pose_out:
        return True

    # 얼굴은 정면이어도 시선이 벗어나면 이탈 후보
    if gaze_out:
        return True

    return False


def count_escape_events(timeline, profile):
    gaze_x_min = profile["gaze_range"]["x_min"]
    gaze_x_max = profile["gaze_range"]["x_max"]
    gaze_y_min = profile["gaze_range"]["y_min"]
    gaze_y_max = profile["gaze_range"]["y_max"]

    pose_x_min = profile["pose_range"]["x_min"]
    pose_x_max = profile["pose_range"]["x_max"]
    pose_y_min = profile["pose_range"].get("y_min", 0)
    pose_y_max = profile["pose_range"].get("y_max", 1)

    escape_count = 0
    escape_streak = 0
    MIN_ESCAPE_STREAK = 1

    for frame in timeline:
        escaped = is_escape_frame(
            frame,
            gaze_x_min,
            gaze_x_max,
            gaze_y_min,
            gaze_y_max,
            pose_x_min,
            pose_x_max,
            pose_y_min,
            pose_y_max
        )

        if escaped:
            escape_streak += 1
        else:
            if escape_streak >= MIN_ESCAPE_STREAK:
                escape_count += 1
            escape_streak = 0

    if escape_streak >= MIN_ESCAPE_STREAK:
        escape_count += 1

    return escape_count


def calculate_escape_ratio(frames, profile):
    if not frames:
        return 0

    gaze_x_min = profile["gaze_range"]["x_min"]
    gaze_x_max = profile["gaze_range"]["x_max"]
    gaze_y_min = profile["gaze_range"]["y_min"]
    gaze_y_max = profile["gaze_range"]["y_max"]

    pose_x_min = profile["pose_range"]["x_min"]
    pose_x_max = profile["pose_range"]["x_max"]
    pose_y_min = profile["pose_range"].get("y_min", 0)
    pose_y_max = profile["pose_range"].get("y_max", 1)

    escape_frames = 0

    for frame in frames:
        if is_escape_frame(
            frame,
            gaze_x_min,
            gaze_x_max,
            gaze_y_min,
            gaze_y_max,
            pose_x_min,
            pose_x_max,
            pose_y_min,
            pose_y_max
        ):
            escape_frames += 1

    return escape_frames / len(frames)


def extract_features(**context):
    data = context["ti"].xcom_pull(task_ids="load_s3_data")

    user_id = data["user_id"]
    test_id = data["test_id"]
    profile = data["calibration_profile"]
    timeline = data["timeline_log"]
    duration = data["duration_minutes"]

    variance_baseline = profile.get("gaze_variance_baseline", 0)

    escape_count = count_escape_events(timeline, profile)

    gaze_x_list = [
        f.get("gaze_x") for f in timeline
        if f.get("face_detected", False)
        and not f.get("is_blinking", False)
        and f.get("gaze_x") is not None
    ]

    gaze_y_list = [
        f.get("gaze_y") for f in timeline
        if f.get("face_detected", False)
        and not f.get("is_blinking", False)
        and f.get("gaze_y") is not None
    ]

    if gaze_x_list and gaze_y_list:
        gaze_variance = float(np.var(gaze_x_list) + np.var(gaze_y_list))
    else:
        gaze_variance = 0.0

    variance_ratio = (
        gaze_variance / variance_baseline
        if variance_baseline and variance_baseline > 0
        else 1
    )

    blink_count = 0
    prev_blinking = False

    for frame in timeline:
        curr_blinking = frame.get("is_blinking", False)

        if curr_blinking and not prev_blinking:
            blink_count += 1

        prev_blinking = curr_blinking

    blink_per_minute = blink_count / duration if duration > 0 else 0

    focus_drop_sections = []
    section_size = 30000

    if timeline:
        start_time = timeline[0]["time"]
        end_time = timeline[-1]["time"]
        current = start_time

        while current < end_time:
            section_frames = [
                f for f in timeline
                if current <= f.get("time", 0) < current + section_size
            ]

            if section_frames:
                escape_ratio_in_section = calculate_escape_ratio(section_frames, profile)

                if escape_ratio_in_section > 0.4:
                    minute = (current - start_time) / 60000
                    focus_drop_sections.append(f"{minute:.1f}min")

            current += section_size

    focus_score = 100

    test_frame_count = len(timeline)
    escape_ratio = escape_count / test_frame_count if test_frame_count > 0 else 0

    focus_score -= escape_ratio * 35

    variance_penalty = max(0, (variance_ratio - 1) * 15)
    focus_score -= min(30, variance_penalty)

    if blink_per_minute > 25:
        focus_score -= 15
    elif blink_per_minute < 5 and duration > 1:
        focus_score -= 5

    MAX_VARIANCE = 0.5
    variance_percent = min(100, round(gaze_variance / MAX_VARIANCE * 100))
    avg_focus = max(0, min(100, round(focus_score)))

    return {
        "user_id": user_id,
        "test_id": test_id,
        "duration_minutes": duration,
        "avg_focus": avg_focus,
        "screen_escape_count": escape_count,
        "gaze_variance": round(gaze_variance, 6),
        "gaze_variance_percent": variance_percent,
        "blink_per_minute": round(blink_per_minute, 1),
        "focus_drop_section": focus_drop_sections
    }


def invoke_bedrock(**context):
    stats = context["ti"].xcom_pull(task_ids="extract_features")

    bedrock = boto3.client("bedrock-runtime", region_name=REGION)

    focus_drop_text = (
        ", ".join(stats["focus_drop_section"])
        if stats["focus_drop_section"]
        else "감지되지 않음"
    )

    prompt = f"""
당신은 시선 추적 기반 청소년 학습 집중도 분석 리포트를 작성하는 교육 데이터 분석가입니다.

반드시 한국어 JSON을 출력하세요.
JSON의 key 이름은 영어로 유지하지만, value의 설명 문장은 모두 한국어로 작성하세요.
이 결과는 학습 보조용 분석이며 의학적 진단이 아닙니다.

[분석 데이터]
- 테스트 시간: {stats['duration_minutes']}분
- 평균 집중도 점수: {stats['avg_focus']}점 / 100점
- 화면 이탈 횟수: {stats['screen_escape_count']}회
- 시선 분산도: {stats['gaze_variance_percent']}% (원시값: {stats['gaze_variance']})
- 분당 눈 깜빡임 blink_per_minute: {stats['blink_per_minute']}회
- 집중도 저하 구간: {focus_drop_text}

[해석 기준]
- 평균 집중도 점수:
- 80점 이상: GOOD
- 60점 이상 80점 미만: NORMAL
- 40점 이상 60점 미만: LOW
- 40점 미만: VERY_LOW

- 테스트 시간이 1분 미만이면 reliability는 LOW로 설정하세요.
- 테스트 시간이 1분 이상 3분 미만이면 reliability는 MEDIUM으로 설정하세요.
- 테스트 시간이 3분 이상이면 reliability는 HIGH로 설정하세요.

- gaze_variance_percent가 50% 미만이면 "안정적"으로 해석하세요.
- gaze_variance_percent가 50% 이상 75% 미만이면 "다소 높음"으로 해석하세요.
- gaze_variance_percent가 75% 이상이면 "높음"으로 해석하세요.

- blink_per_minute가 5회 미만이면 "낮은 편"으로 해석하세요.
- blink_per_minute가 5회 이상 25회 이하면 "일반적인 범위"으로 해석하세요.
- blink_per_minute가 25회 초과이면 "높은 편"으로 해석하세요.

- focus_drop_section이 비어 있어도 문제가 없다고 단정하지 마세요.
- 테스트 시간이 짧으면 반드시 예비 분석이라고 설명하세요.
- 과장하지 말고, 의학적 진단처럼 말하지 마세요.

[개선 조언 작성 규칙]
- 대상은 중고등학생 학습자입니다.
- recommendations는 생활 습관 조언보다 학습 행동 개선 중심으로 작성하세요.
- "휴식", "눈 운동", "스트레칭", "조명 조절", "환경 정리", "알림 끄기" 같은 일반 건강/환경 조언은 작성하지 마세요.
- 실제 학습 상황에서 바로 적용할 수 있는 독해, 문제 풀이, 복습 전략을 제안하세요.
- 각 recommendation의 solution은 최소 150자 이상, 최대 250자 이하로 작성하세요.

[중요 출력 규칙]
반드시 아래 JSON 형식만 출력하세요.
마크다운, 설명문, 코드블록, 따옴표 밖 텍스트를 절대 추가하지 마세요.
JSON 파싱이 가능해야 합니다.

{{
  "summary": {{
    "title": "string",
    "level": "GOOD | NORMAL | LOW | VERY_LOW",
    "reliability": "LOW | MEDIUM | HIGH",
    "short_comment": "string"
  }},
  "metrics_interpretation": {{
    "focus": {{
      "score": {stats['avg_focus']},
      "label": "string",
      "description": "string"
    }},
    "screen_escape": {{
      "count": {stats['screen_escape_count']},
      "label": "string",
      "description": "string"
    }},
    "gaze_variance": {{
      "value": {stats['gaze_variance_percent']},
      "label": "string",
      "description": "string"
    }},
    "blink": {{
      "value": {stats['blink_per_minute']},
      "label": "string",
      "description": "string"
    }}
  }},
  "focus_drop": {{
    "has_drop_section": false,
    "sections": [],
    "description": "string"
  }},
  "warnings": [
    "string"
  ],
  "recommendations": [
    {{
      "category": "독해 전략",
      "problem": "string",
      "cause": "string",
      "solution": "150~250자 분량의 자연스러운 한국어 설명"
    }},
    {{
      "category": "문제 풀이 전략",
      "problem": "string",
      "cause": "string",
      "solution": "150~250자 분량의 자연스러운 한국어 설명"
    }},
    {{
      "category": "복습 전략",
      "problem": "string",
      "cause": "string",
      "solution": "150~250자 분량의 자연스러운 한국어 설명"
    }}
  ]
}}
"""

    response = bedrock.invoke_model(
        modelId=BEDROCK_MODEL_ID,
        body=json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 1800,
            "messages": [
                {
                    "role": "user",
                    "content": prompt
                }
            ]
        })
    )

    response_body = json.loads(response["body"].read())
    ai_report_text = response_body["content"][0]["text"].strip()

    try:
        ai_report = json.loads(ai_report_text)
    except json.JSONDecodeError:
        ai_report = {
            "summary": {
                "title": "분석 결과 생성 오류",
                "level": "UNKNOWN",
                "reliability": "LOW",
                "short_comment": "AI 리포트를 JSON 형식으로 변환하지 못했습니다."
            },
            "metrics_interpretation": {
                "focus": {
                    "score": stats["avg_focus"],
                    "label": "분석 실패",
                    "description": "집중도 해석 결과를 불러오지 못했습니다."
                },
                "screen_escape": {
                    "count": stats["screen_escape_count"],
                    "label": "분석 실패",
                    "description": "화면 이탈 해석 결과를 불러오지 못했습니다."
                },
                "gaze_variance": {
                    "value": stats["gaze_variance_percent"],
                    "label": "분석 실패",
                    "description": "시선 분산도 해석 결과를 불러오지 못했습니다."
                },
                "blink": {
                    "value": stats["blink_per_minute"],
                    "label": "분석 실패",
                    "description": "눈 깜빡임 해석 결과를 불러오지 못했습니다."
                }
            },
            "focus_drop": {
                "has_drop_section": False,
                "sections": [],
                "description": "집중도 저하 구간 해석 결과를 불러오지 못했습니다."
            },
            "warnings": [
                "AI 응답을 JSON으로 파싱하지 못했습니다."
            ],
            "recommendations": [
                {
                    "category": "독해 전략",
                    "problem": "AI 리포트가 정상적으로 생성되지 않았습니다.",
                    "cause": "모델 응답에 JSON 외의 문장이 포함되었거나 출력 형식이 깨졌을 가능성이 있습니다.",
                    "solution": "동일한 테스트를 다시 분석하고, 같은 문제가 반복되면 프롬프트의 출력 형식을 더 단순화하세요. 대시보드에서는 임시로 집중도 점수, 화면 이탈 횟수, 시선 분산도만 표시해도 기본 분석 결과는 전달할 수 있습니다."
                }
            ]
        }

    return {
        **stats,
        "ai_report": ai_report
    }


def save_report(**context):
    result = context["ti"].xcom_pull(task_ids="invoke_bedrock")

    user_id = result["user_id"]
    test_id = result["test_id"]

    report = {
        "user_id": user_id,
        "test_id": test_id,
        "created_at": datetime.now().isoformat(),
        "duration_minutes": result["duration_minutes"],
        "focus_score": {
            "avg_focus": result["avg_focus"],
            "screen_escape_count": result["screen_escape_count"],
            "gaze_variance": result["gaze_variance"],
            "gaze_variance_percent": result["gaze_variance_percent"],
            "blink_per_minute": result["blink_per_minute"],
            "focus_drop_section": result["focus_drop_section"]
        },
        "ai_report": result["ai_report"]
    }

    s3 = boto3.client("s3", region_name=REGION)

    report_key = f"reports/{user_id}/{test_id}/report.json"

    s3.put_object(
        Bucket=S3_REPORT_BUCKET,
        Key=report_key,
        Body=json.dumps(report, ensure_ascii=False, indent=2),
        ContentType="application/json"
    )

    return report_key


with DAG(
    dag_id="eye_tracking_pipeline",
    start_date=datetime(2024, 1, 1),
    schedule_interval=None,
    catchup=False,
    tags=["eye-tracking"],
) as dag:

    task1 = PythonOperator(
        task_id="load_s3_data",
        python_callable=load_s3_data,
    )

    task2 = PythonOperator(
        task_id="extract_features",
        python_callable=extract_features,
    )

    task3 = PythonOperator(
        task_id="invoke_bedrock",
        python_callable=invoke_bedrock,
    )

    task4 = PythonOperator(
        task_id="save_report",
        python_callable=save_report,
    )

    task1 >> task2 >> task3 >> task4