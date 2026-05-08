import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import {
  S3Client,
  PutObjectCommand
} from "@aws-sdk/client-s3";
import { fromCognitoIdentityPool } from "@aws-sdk/credential-providers";
import { fetchUserAttributes } from "aws-amplify/auth";

// --- AWS S3 설정 ---
const REGION = import.meta.env.VITE_AWS_REGION;
const RAW_BUCKET = import.meta.env.VITE_RAW_BUCKET;
const IDENTITY_POOL_ID = import.meta.env.VITE_COGNITO_IDENTITY_POOL_ID;

const s3Client = new S3Client({
  region: REGION,
  credentials: fromCognitoIdentityPool({
    clientConfig: { region: REGION },
    identityPoolId: IDENTITY_POOL_ID
  })
});

const uploadJsonToS3 = async (key, data) => {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: RAW_BUCKET,
      Key: key,
      Body: JSON.stringify(data, null, 2),
      ContentType: "application/json"
    })
  );
};

const createTimeBasedTestId = () => {
  const timestamp = new Date()
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replaceAll(".", "")
    .replaceAll("T", "")
    .replaceAll("Z", "")
    .slice(0, 14);

  return `test-${timestamp}`;
};

const CALIB_STEPS = [
  { phase: 'CENTER', text: "화면 중앙의 빨간 점을 응시하세요 (정면)", time: 10 },
  { phase: 'LEFT_GAZE', text: "눈동자만 왼쪽으로 이동하세요", time: 4 },
  { phase: 'RIGHT_GAZE', text: "눈동자만 오른쪽으로 이동하세요", time: 4 },
  { phase: 'UP_GAZE', text: "눈동자만 위로 이동하세요", time: 4 },
  { phase: 'DOWN_GAZE', text: "눈동자만 아래로 이동하세요", time: 4 },
  { phase: 'HEAD_LEFT', text: "고개를 천천히 왼쪽으로 돌리세요", time: 4 },
  { phase: 'HEAD_RIGHT', text: "고개를 천천히 오른쪽으로 돌리세요", time: 4 },
  { phase: 'BLINK', text: "평소처럼 눈을 여러 번 깜빡여주세요", time: 4 }
];

const clamp = (value, min, max) => {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.min(Math.max(value, min), max);
};

const clamp01 = value => clamp(value, 0, 1);

const cleanValues = arr =>
  arr.filter(v => v !== null && v !== undefined && !Number.isNaN(v));

const avg = arr => {
  const values = cleanValues(arr);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
};

const variance = arr => {
  const values = cleanValues(arr);
  if (!values.length) return 0;
  const mean = avg(values);
  return values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
};

const percentile = (arr, p) => {
  const values = cleanValues(arr).sort((a, b) => a - b);
  if (!values.length) return 0;
  const index = Math.floor((values.length - 1) * p);
  return values[index];
};

const round4 = value => Number(value.toFixed(4));
const round6 = value => Number(value.toFixed(6));

const TestPage = () => {
  const [appState, setAppState] = useState('INIT');
  const [status, setStatus] = useState("AI 모델을 다운로드하고 있습니다...");
  const [stepIndex, setStepIndex] = useState(0);
  const [countdown, setCountdown] = useState(0);

  const [passage, setPassage] = useState(null);
  const [currentPage, setCurrentPage] = useState(0);

  const videoRef = useRef(null);
  const landmarkerRef = useRef(null);
  const requestRef = useRef(null);
  const navigate = useNavigate();

  const currentPhaseRef = useRef('INIT');
  const lastCaptureTime = useRef(0);
  const userProfileRef = useRef(null);

  const sessionData = useRef({
    calibration: {
      CENTER: [],
      LEFT_GAZE: [],
      RIGHT_GAZE: [],
      UP_GAZE: [],
      DOWN_GAZE: [],
      HEAD_LEFT: [],
      HEAD_RIGHT: [],
      BLINK: []
    },
    test: []
  });

  useEffect(() => {
    let isMounted = true;

    const initAI = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
        );

        landmarkerRef.current = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true
        });

        if (isMounted) {
          setStatus("분석 분야를 선택해 주세요.");
          setAppState('CATEGORY_SELECT');
        }
      } catch (err) {
        if (isMounted) setStatus("AI 로딩 실패: " + err.message);
      }
    };

    initAI();

    return () => {
      isMounted = false;

      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
      }

      if (videoRef.current?.srcObject) {
        videoRef.current.srcObject.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  useEffect(() => {
    let timer;

    if (appState === 'CALIBRATING') {
      if (countdown > 0) {
        timer = setTimeout(() => setCountdown(c => c - 1), 1000);
      } else {
        if (stepIndex < CALIB_STEPS.length - 1) {
          const nextIndex = stepIndex + 1;

          setStepIndex(nextIndex);
          setCountdown(CALIB_STEPS[nextIndex].time);
          currentPhaseRef.current = CALIB_STEPS[nextIndex].phase;
        } else {
          generateCalibrationProfile();
          setAppState('TESTING');
          currentPhaseRef.current = 'TESTING';
          setStatus("테스트 진행 중입니다. 백그라운드에서 시선 데이터를 수집합니다.");
        }
      }
    }

    return () => clearTimeout(timer);
  }, [appState, countdown, stepIndex]);

  const handleCategorySelect = async (category) => {
    try {
      setStatus("지문을 불러오는 중...");

      const response = await fetch('/texts.json');
      if (!response.ok) throw new Error("texts.json 파일을 찾을 수 없습니다.");

      const data = await response.json();
      const targetList = data.passages || data;
      const filtered = targetList.filter(p => p.category === category);

      if (filtered.length === 0) {
        setStatus("해당 카테고리에 지문이 없습니다.");
        return;
      }

      setPassage(filtered[Math.floor(Math.random() * filtered.length)]);
      setAppState('READY');
      setStatus("준비 완료. 환경 세팅을 시작하세요.");
    } catch (err) {
      setStatus("데이터 로드 실패: texts.json 파일을 확인하세요.");
    }
  };

  const startCalibration = async () => {
    try {
      sessionData.current = {
        calibration: {
          CENTER: [],
          LEFT_GAZE: [],
          RIGHT_GAZE: [],
          UP_GAZE: [],
          DOWN_GAZE: [],
          HEAD_LEFT: [],
          HEAD_RIGHT: [],
          BLINK: []
        },
        test: []
      };

      userProfileRef.current = null;

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 }
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;

        videoRef.current.onloadedmetadata = async () => {
          await videoRef.current.play();

          setAppState('CALIBRATING');
          setStepIndex(0);
          setCountdown(CALIB_STEPS[0].time);

          currentPhaseRef.current = CALIB_STEPS[0].phase;
          lastCaptureTime.current = 0;

          predict();
        };
      }
    } catch (err) {
      alert("카메라 권한이 필요합니다.");
    }
  };

  const getEyeNormalizedPosition = (
    landmarks,
    irisIndex,
    leftCornerIndex,
    rightCornerIndex,
    upperLidIndex,
    lowerLidIndex
  ) => {
    const iris = landmarks[irisIndex];
    const lc = landmarks[leftCornerIndex];
    const rc = landmarks[rightCornerIndex];
    const ul = landmarks[upperLidIndex];
    const ll = landmarks[lowerLidIndex];

    if (!iris || !lc || !rc || !ul || !ll) return null;

    const eyeLeftX = Math.min(lc.x, rc.x);
    const eyeRightX = Math.max(lc.x, rc.x);
    const eyeTopY = Math.min(ul.y, ll.y);
    const eyeBottomY = Math.max(ul.y, ll.y);

    const eyeW = eyeRightX - eyeLeftX;
    const eyeH = eyeBottomY - eyeTopY;

    if (eyeW <= 0.001 || eyeH <= 0.001) return null;

    return {
      x: clamp01((iris.x - eyeLeftX) / eyeW),
      y: clamp01((iris.y - eyeTopY) / eyeH)
    };
  };

  const getPoseNormalizedPosition = landmarks => {
    const lf = landmarks[234];
    const rf = landmarks[454];
    const tf = landmarks[10];
    const bf = landmarks[152];
    const nose = landmarks[1];

    if (!lf || !rf || !tf || !bf || !nose) {
      return { x: null, y: null };
    }

    const fLX = Math.min(lf.x, rf.x);
    const fRX = Math.max(lf.x, rf.x);
    const fTY = Math.min(tf.y, bf.y);
    const fBY = Math.max(tf.y, bf.y);

    const fW = fRX - fLX;
    const fH = fBY - fTY;

    if (fW <= 0.001 || fH <= 0.001) {
      return { x: null, y: null };
    }

    return {
      x: clamp01((nose.x - fLX) / fW),
      y: clamp01((nose.y - fTY) / fH)
    };
  };

  const extractFeatures = (results, timestamp, phaseName) => {
    const isFaceDetected = results.faceLandmarks && results.faceLandmarks.length > 0;

    const frameData = {
      time: Math.round(timestamp),
      face_detected: isFaceDetected,
      gaze_x: null,
      gaze_y: null,
      pose_x: null,
      pose_y: null,
      blink_score: 0
    };

    if (isFaceDetected) {
      const landmarks = results.faceLandmarks[0];
      const blendshapes = results.faceBlendshapes[0]?.categories || [];

      const blinkL =
        blendshapes.find(s => s.categoryName === "eyeBlinkLeft")?.score || 0;
      const blinkR =
        blendshapes.find(s => s.categoryName === "eyeBlinkRight")?.score || 0;

      frameData.blink_score = clamp01(Math.max(blinkL, blinkR)) ?? 0;

      const leftEye = getEyeNormalizedPosition(
        landmarks,
        468,
        33,
        133,
        159,
        145
      );

      const rightEye = getEyeNormalizedPosition(
        landmarks,
        473,
        362,
        263,
        386,
        374
      );

      const gazeXValues = cleanValues([leftEye?.x, rightEye?.x]);
      const gazeYValues = cleanValues([leftEye?.y, rightEye?.y]);

      frameData.gaze_x = gazeXValues.length ? clamp01(avg(gazeXValues)) : null;
      frameData.gaze_y = gazeYValues.length ? clamp01(avg(gazeYValues)) : null;

      const pose = getPoseNormalizedPosition(landmarks);

      frameData.pose_x = clamp01(pose.x);
      frameData.pose_y = clamp01(pose.y);
    }

    if (phaseName === 'TESTING') {
      sessionData.current.test.push(frameData);
    } else if (sessionData.current.calibration[phaseName]) {
      sessionData.current.calibration[phaseName].push(frameData);
    }
  };

  const predict = () => {
    if (
      videoRef.current &&
      landmarkerRef.current &&
      videoRef.current.readyState >= 2
    ) {
      const currentTimeMs = performance.now();

      const results = landmarkerRef.current.detectForVideo(
        videoRef.current,
        currentTimeMs
      );

      const captureInterval = currentPhaseRef.current === 'TESTING' ? 1000 : 200;

      if (currentTimeMs - lastCaptureTime.current >= captureInterval) {
        lastCaptureTime.current = currentTimeMs;
        extractFeatures(results, currentTimeMs, currentPhaseRef.current);
      }
    }

    requestRef.current = requestAnimationFrame(predict);
  };

  const getSafeRange = (minSource, maxSource, fallbackMin, fallbackMax, margin = 0) => {
    const minValues = cleanValues(minSource);
    const maxValues = cleanValues(maxSource);

    const minValue = minValues.length ? percentile(minValues, 0.1) : fallbackMin;
    const maxValue = maxValues.length ? percentile(maxValues, 0.9) : fallbackMax;

    const rawMin = Math.min(minValue, maxValue) - margin;
    const rawMax = Math.max(minValue, maxValue) + margin;

    const safeMin = clamp01(rawMin);
    const safeMax = clamp01(rawMax);

    return {
      min: safeMin ?? fallbackMin,
      max: safeMax ?? fallbackMax
    };
  };

  const generateCalibrationProfile = () => {
    const calib = sessionData.current.calibration;

    const centerGazeX = cleanValues(calib.CENTER.map(d => d.gaze_x));
    const centerGazeY = cleanValues(calib.CENTER.map(d => d.gaze_y));
    const centerPoseX = cleanValues(calib.CENTER.map(d => d.pose_x));
    const centerPoseY = cleanValues(calib.CENTER.map(d => d.pose_y));

    const leftGazeX = cleanValues(calib.LEFT_GAZE.map(d => d.gaze_x));
    const rightGazeX = cleanValues(calib.RIGHT_GAZE.map(d => d.gaze_x));
    const upGazeY = cleanValues(calib.UP_GAZE.map(d => d.gaze_y));
    const downGazeY = cleanValues(calib.DOWN_GAZE.map(d => d.gaze_y));

    const headLeftPoseX = cleanValues(calib.HEAD_LEFT.map(d => d.pose_x));
    const headRightPoseX = cleanValues(calib.HEAD_RIGHT.map(d => d.pose_x));

    const allPoseY = cleanValues([
      ...calib.CENTER.map(d => d.pose_y),
      ...calib.HEAD_LEFT.map(d => d.pose_y),
      ...calib.HEAD_RIGHT.map(d => d.pose_y)
    ]);
    const blinkScores = cleanValues(calib.BLINK.map(d => d.blink_score));

    const gazeCenterX = clamp01(avg(centerGazeX)) ?? 0.5;
    const gazeCenterY = clamp01(avg(centerGazeY)) ?? 0.5;
    const poseCenterX = clamp01(avg(centerPoseX)) ?? 0.5;
    const poseCenterY = clamp01(avg(centerPoseY)) ?? 0.5;

    const gazeMargin = 0.07;
    const poseMargin = 0.06;

    const gazeXRange = getSafeRange(leftGazeX, rightGazeX, 0.15, 0.85, gazeMargin);
    const gazeYRange = getSafeRange(upGazeY, downGazeY, 0.15, 0.85, gazeMargin);

    const poseXMinRaw = headLeftPoseX.length
      ? percentile(headLeftPoseX, 0.1) - poseMargin
      : poseCenterX - poseMargin;

    const poseXMaxRaw = headRightPoseX.length
      ? percentile(headRightPoseX, 0.9) + poseMargin
      : poseCenterX + poseMargin;

    const poseYMinRaw = allPoseY.length
      ? percentile(allPoseY, 0.1) - poseMargin
      : poseCenterY - poseMargin;

    const poseYMaxRaw = allPoseY.length
      ? percentile(allPoseY, 0.9) + poseMargin
      : poseCenterY + poseMargin;

    userProfileRef.current = {
      gaze_center: {
        x: round4(gazeCenterX),
        y: round4(gazeCenterY)
      },
      gaze_range: {
        x_min: round4(gazeXRange.min),
        x_max: round4(gazeXRange.max),
        y_min: round4(gazeYRange.min),
        y_max: round4(gazeYRange.max)
      },
      gaze_variance_baseline: round6(
        variance([
          ...centerGazeX.map(v => clamp01(v)),
          ...centerGazeY.map(v => clamp01(v))
        ])
      ),
      pose_center: {
        x: round4(poseCenterX),
        y: round4(poseCenterY)
      },
      pose_range: {
        x_min: round4(clamp01(Math.min(poseXMinRaw, poseXMaxRaw)) ?? 0),
        x_max: round4(clamp01(Math.max(poseXMinRaw, poseXMaxRaw)) ?? 1),
        y_min: round4(clamp01(Math.min(poseYMinRaw, poseYMaxRaw)) ?? 0),
        y_max: round4(clamp01(Math.max(poseYMinRaw, poseYMaxRaw)) ?? 1)
      },
      blink_threshold: round4(
        blinkScores.length ? clamp01(percentile(blinkScores, 0.9) * 0.8) : 0.55
      )
    };
  };

  

  const handleFinish = async () => {
    try {
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
      }

      if (videoRef.current?.srcObject) {
        videoRef.current.srcObject.getTracks().forEach(track => track.stop());
      }

      if (!userProfileRef.current || !sessionData.current.test.length) {
        alert("데이터가 없습니다.");
        return;
      }

      const attributes = await fetchUserAttributes();
      const email = attributes.email?.trim().toLowerCase();
      const sub = attributes.sub;

      if (!email || !sub) {
        alert("Cognito 사용자 정보를 가져오지 못했습니다.");
        return;
      }

      const emailName = email.split("@")[0];
      const userId = sub;
      const testId = createTimeBasedTestId();

      const testLogs = sessionData.current.test;
      const testMinutes =
        (testLogs[testLogs.length - 1].time - testLogs[0].time) / 60000;

      const baseKey = `raw/${userId}/${testId}`;

      const createdAt = new Date().toISOString();

      const calibrationJson = {
        user_info: {
          user_email: email,
          user_id: userId,
          cognito_sub: sub
        },
        test_info: {
          test_id: testId,
          created_at: createdAt
        },
        calibration_profile: userProfileRef.current
      };

      const gazeDataJson = {
        user_info: {
          user_email: email,
          user_id: userId,
          cognito_sub: sub
        },
        test_info: {
          test_id: testId,
          created_at: createdAt,
          duration_minutes: Number(testMinutes.toFixed(2))
        },
        timeline_log: testLogs.map(log => ({
          time: log.time,
          face_detected: log.face_detected,
          gaze_x: log.gaze_x !== null ? round4(clamp01(log.gaze_x)) : null,
          gaze_y: log.gaze_y !== null ? round4(clamp01(log.gaze_y)) : null,
          pose_x: log.pose_x !== null ? round4(clamp01(log.pose_x)) : null,
          pose_y: log.pose_y !== null ? round4(clamp01(log.pose_y)) : null,
          is_blinking:
            log.blink_score >= userProfileRef.current.blink_threshold 
        }))
      };

      await uploadJsonToS3(
        `${baseKey}/calibration/calibration.json`,
        calibrationJson
      );

      await uploadJsonToS3(
        `${baseKey}/test/gaze_data.json`,
        gazeDataJson
      );

      navigate("/result", {
        state: {
          rawAnalysisData: {
            user_id: userId,
            test_id: testId
          }
        }
      });

      
    } catch (err) {
      alert("S3 저장 중 오류가 발생했습니다: " + err.message);
    }
  };

  const CATEGORIES = [
    { id: '과학', title: '인공지능의 정의와 원리' },
    { id: '음악', title: 'K-pop의 정의와 현대적 위상' },
    { id: '경제', title: '인센티브 계약의 방식과 원리' },
    { id: '사회', title: "법 해석의 방법과 '담보'의 다각적 의미" },
    { id: '철학', title: '인격의 동일성에 관한 칸트와 현대 철학 논쟁' }
  ];

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center py-10 font-sans relative">
      <div
        className={`fixed top-8 right-8 w-60 h-44 bg-slate-900 rounded-2xl overflow-hidden border-4 border-slate-200 shadow-2xl z-50 transition-all duration-500 ${
          appState === 'CALIBRATING'
            ? 'opacity-100 translate-y-0'
            : 'opacity-0 -translate-y-4 pointer-events-none'
        }`}
      >
        <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-cover"
        style={{ transform: "scaleX(-1)" }}
      />
      </div>

      <div className="max-w-4xl w-full bg-white rounded-3xl shadow-xl p-10 text-slate-800 border border-slate-200 min-h-[600px] flex flex-col relative">
        <div className="flex justify-between items-end mb-8 border-b pb-4">
          <div>
            <h2 className="text-3xl font-black text-blue-600 mb-2">
              DAILy Reading
            </h2>
            <p
              className={`font-bold flex items-center gap-2 ${
                appState === 'TESTING' ? 'text-red-500' : 'text-slate-500'
              }`}
            >
              {appState === 'TESTING' && (
                <span className="w-3 h-3 bg-red-500 rounded-full animate-ping"></span>
              )}
              {status}
            </p>
          </div>

          {appState === 'READY' && (
            <button
              onClick={startCalibration}
              className="px-6 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all"
            >
              환경 세팅 및 시작
            </button>
          )}

          {appState === 'TESTING' && (
            <button
              onClick={handleFinish}
              className="px-6 py-3 bg-slate-800 text-white rounded-xl font-bold hover:bg-slate-900 transition-all shadow-md"
            >
              제출 및 종료
            </button>
          )}
        </div>

        <div className="flex-1 flex flex-col relative">
          {appState === 'INIT' && (
            <div className="flex-1 flex items-center justify-center text-slate-400 font-medium text-center px-4">
              AI 엔진을 준비하고 있습니다.
            </div>
          )}

          {appState === 'CATEGORY_SELECT' && (
            <div className="flex-1 flex flex-col justify-center space-y-5">
              <h3 className="text-xl font-bold text-center text-slate-600 mb-4 font-sans">
                분석 대상을 선택하세요
              </h3>

              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {CATEGORIES.map(cat => (
                  <button
                    key={cat.id}
                    onClick={() => handleCategorySelect(cat.id)}
                    className="p-5 border-2 border-slate-100 rounded-2xl text-left hover:border-blue-500 transition-all active:scale-95 group flex flex-col justify-center h-full"
                  >
                    <span className="text-xs font-bold text-blue-400 block mb-1 tracking-widest">
                      {cat.id}
                    </span>
                    <span className="text-lg font-bold text-slate-700 font-black truncate w-full">
                      {cat.title}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {appState === 'READY' && (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-4">
              <p className="text-slate-500 font-bold text-lg mb-2">
                지문이 로드되었습니다.
              </p>
              <p className="text-slate-400 text-sm">
                제출 시 로그인된 Cognito 이메일 기준으로 S3에 저장됩니다.
              </p>
            </div>
          )}

          {appState === 'CALIBRATING' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-50 rounded-2xl z-10 transition-all border-2 border-dashed border-slate-300">
              <h3 className="text-xl font-bold mb-8 text-slate-500">
                기본 환경 세팅 중 ({stepIndex + 1}/8)
              </h3>

              {CALIB_STEPS[stepIndex].phase === 'CENTER' && (
                <div className="relative flex items-center justify-center w-32 h-32 mb-6">
                  <div className="absolute w-full h-full bg-red-400 rounded-full animate-ping opacity-75"></div>
                  <div className="relative w-8 h-8 bg-red-600 rounded-full shadow-lg z-10"></div>
                </div>
              )}

              <div className="text-3xl font-black text-blue-600 mb-8 h-12 flex items-center justify-center text-center px-4">
                {CALIB_STEPS[stepIndex].text}
              </div>

              <div className="text-6xl font-black text-slate-300">
                {countdown}
              </div>
            </div>
          )}

          {appState === 'TESTING' && passage && (
            <div className="flex-1 flex flex-col animate-in slide-in-from-bottom-10 duration-700 h-full">
              <div className="flex-1 bg-white p-8 rounded-2xl overflow-y-auto border border-slate-100 shadow-inner h-[400px]">
                <h4 className="text-2xl font-bold mb-6 text-slate-800 border-l-4 border-blue-600 pl-4">
                  {passage.title}
                </h4>

                <div className="text-lg leading-[2.2] text-slate-700 whitespace-pre-wrap font-medium">
                  {passage.content_pages[currentPage]}
                </div>
              </div>

              <div className="mt-6 flex justify-between items-center">
                <span className="text-slate-400 font-black tracking-widest uppercase text-xs">
                  PAGE {currentPage + 1} / {passage.content_pages.length}
                </span>

                <div className="space-x-2">
                  {currentPage > 0 && (
                    <button
                      onClick={() => setCurrentPage(p => p - 1)}
                      className="px-6 py-2 bg-slate-200 rounded-lg font-bold hover:bg-slate-300 transition-colors"
                    >
                      이전
                    </button>
                  )}

                  {currentPage < passage.content_pages.length - 1 && (
                    <button
                      onClick={() => setCurrentPage(p => p + 1)}
                      className="px-6 py-2 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 transition-colors"
                    >
                      다음
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TestPage;