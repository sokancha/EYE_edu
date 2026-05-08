import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { fromCognitoIdentityPool } from "@aws-sdk/credential-providers";

const REGION = import.meta.env.VITE_AWS_REGION;
const REPORT_BUCKET = import.meta.env.VITE_REPORT_BUCKET;
const IDENTITY_POOL_ID = import.meta.env.VITE_COGNITO_IDENTITY_POOL_ID;

const s3Client = new S3Client({
  region: REGION,
  credentials: fromCognitoIdentityPool({
    clientConfig: { region: REGION },
    identityPoolId: IDENTITY_POOL_ID
  })
});

const streamToString = async (stream) => {
  if (stream.transformToString) {
    return await stream.transformToString();
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }

  return result;
};

const fetchReportFromS3 = async (userId, testId) => {
  const key = `reports/${userId}/${testId}/report.json`;

  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: REPORT_BUCKET,
      Key: key
    })
  );

  const bodyText = await streamToString(response.Body);
  return JSON.parse(bodyText);
};

const ResultPage = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const initialData = location.state?.rawAnalysisData;

  const [reportData, setReportData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!initialData?.user_id || !initialData?.test_id) {
      setErrorMessage("분석 리포트를 조회할 user_id 또는 test_id가 없습니다.");
      setLoading(false);
      return;
    }

    let isMounted = true;
    let retryCount = 0;
    const maxRetry = 20;

    const loadReport = async () => {
      try {
        const report = await fetchReportFromS3(
          initialData.user_id,
          initialData.test_id
        );

        if (isMounted) {
          setReportData(report);
          setLoading(false);
        }
      } catch (err) {
        retryCount += 1;

        if (retryCount >= maxRetry) {
          if (isMounted) {
            setErrorMessage(
              "리포트 생성이 아직 완료되지 않았거나 S3 조회 권한이 없습니다: " + err.message
            );
            setLoading(false);
          }
          return;
        }

        setTimeout(loadReport, 3000);
      }
    };

    loadReport();

    return () => {
      isMounted = false;
    };
  }, [initialData]);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 p-8">
        <h2 className="text-2xl font-black text-slate-800 mb-4">
          분석 리포트를 생성 중입니다.
        </h2>
        <p className="text-slate-500 font-bold">
          Airflow와 Bedrock 분석이 끝나면 자동으로 결과가 표시됩니다.
        </p>
      </div>
    );
  }

  if (errorMessage || !reportData) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 p-8">
        <h2 className="text-2xl font-black text-slate-800 mb-4">
          분석 리포트를 불러올 수 없습니다.
        </h2>
        <p className="text-slate-500 font-bold mb-6 text-center">
          {errorMessage}
        </p>
        <button
          onClick={() => navigate('/')}
          className="px-6 py-3 bg-blue-600 text-white rounded-2xl font-bold hover:bg-blue-700 transition-all"
        >
          다시 테스트하기
        </button>
      </div>
    );
  }

  const { test_id, created_at, ai_report } = reportData;
  const { summary, metrics_interpretation, recommendations, warnings, focus_drop } = ai_report;

  return (
    <div className="min-h-screen bg-[#F8FAFC] p-6 md:p-12 font-sans text-slate-900">
      <div className="max-w-6xl mx-auto">

        <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-12 gap-6">
          <div>
            <span className="text-blue-600 font-black text-xs uppercase tracking-[0.3em] mb-3 block">
              AI Focus Analysis
            </span>
            <h1 className="text-4xl md:text-5xl font-black text-slate-900 tracking-tight mb-2">
              {summary.title}
            </h1>
            <p className="text-slate-400 font-bold">
              ID: {test_id} | 분석 일시: {new Date(created_at).toLocaleString()}
            </p>
          </div>
          <button
            onClick={() => navigate('/')}
            className="px-6 py-3 bg-white border-2 border-slate-200 text-slate-600 rounded-2xl font-black text-sm hover:bg-slate-50 transition-all shadow-sm"
          >
            새로운 테스트 시작
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-12">
          <div className="lg:col-span-1 bg-white rounded-[40px] p-10 shadow-sm border border-slate-100 flex flex-col items-center justify-center text-center">
            <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">
              Focus Level
            </p>
            <div className={`text-7xl font-black mb-4 ${summary.level === 'LOW' || summary.level === 'VERY_LOW' ? 'text-red-500' : 'text-blue-600'}`}>
              {summary.level}
            </div>
            <div className="px-4 py-1 rounded-full text-[10px] font-black uppercase border-2 border-slate-100 text-slate-400">
              신뢰도: {summary.reliability}
            </div>
          </div>

          <div className="lg:col-span-2 bg-blue-600 rounded-[40px] p-10 shadow-2xl shadow-blue-200 text-white relative overflow-hidden flex flex-col justify-center">
            <div className="absolute top-[-20px] right-[-20px] w-40 h-40 bg-white/10 rounded-full blur-3xl"></div>
            <h3 className="text-2xl font-black mb-4 flex items-center gap-2">
              <span className="text-3xl">🤖</span> AI 분석 총평
            </h3>
            <p className="text-xl font-bold leading-relaxed opacity-95 italic">
              "{summary.short_comment}"
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
          {[
            {
              label: '집중 점수',
              ...metrics_interpretation.focus,
              unit: '점',
              color: 'text-blue-600',
              val: metrics_interpretation.focus.score
            },
            {
              label: '화면 이탈',
              ...metrics_interpretation.screen_escape,
              unit: '회',
              color: 'text-red-500',
              val: metrics_interpretation.screen_escape.count
            },
            {
              label: '시선 분산',
              ...metrics_interpretation.gaze_variance,
              unit: '%',
              color: 'text-amber-500',
              val: Number(metrics_interpretation.gaze_variance.value).toFixed(0)
            },
            {
              label: '눈 깜빡임',
              ...metrics_interpretation.blink,
              unit: 'bpm',
              color: 'text-indigo-500',
              val: metrics_interpretation.blink.value
            }
          ].map((m, i) => (
            <div key={i} className="bg-white p-8 rounded-[32px] border border-slate-100 shadow-sm flex flex-col h-full">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">
                {m.label}
              </p>
              <div className="flex items-end gap-1 mb-3">
                <span className={`text-4xl font-black ${m.color}`}>
                  {m.val}
                </span>
                <span className="text-slate-400 font-bold text-sm mb-1">
                  {m.unit}
                </span>
                <span className="ml-auto text-[10px] font-black px-2 py-0.5 bg-slate-100 rounded text-slate-500">
                  {m.label}
                </span>
              </div>
              <p className="text-xs text-slate-500 font-bold leading-relaxed">
                {m.description}
              </p>
            </div>
          ))}
        </div>

        <div className="mb-12">
          <div className="flex items-center gap-4 mb-8">
            <h3 className="text-2xl font-black text-slate-900">
              💡 맞춤형 학습 전략
            </h3>
            <div className="h-[2px] flex-1 bg-slate-100"></div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {recommendations.map((rec, i) => (
              <div key={i} className="bg-white rounded-[32px] p-8 border border-slate-100 shadow-sm hover:shadow-md transition-all flex flex-col">
                <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center text-xl mb-6 font-black">
                  {i + 1}
                </div>
                <p className="text-blue-600 font-black text-[10px] uppercase tracking-widest mb-2">
                  {rec.category}
                </p>
                <h4 className="text-lg font-black text-slate-800 mb-4 leading-tight">
                  {rec.problem}
                </h4>
                <div className="mt-auto space-y-4">
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <p className="text-[10px] font-black text-slate-400 mb-1 uppercase">
                      Cause
                    </p>
                    <p className="text-xs text-slate-600 font-bold">
                      {rec.cause}
                    </p>
                  </div>
                  <div className="p-4 bg-blue-600 rounded-2xl text-white shadow-lg shadow-blue-100">
                    <p className="text-[10px] font-black text-white/60 mb-1 uppercase">
                      Solution
                    </p>
                    <p className="text-xs font-bold leading-relaxed">
                      {rec.solution}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="bg-slate-900 rounded-[40px] p-10 text-white shadow-xl">
            <h4 className="text-xl font-black mb-6 flex items-center gap-2 text-amber-400">
              <span>⚠️</span> 분석 유의사항 (Warnings)
            </h4>
            <ul className="space-y-4">
              {warnings.map((w, i) => (
                <li key={i} className="text-slate-400 text-sm font-bold flex items-start gap-3 italic">
                  <span className="w-1.5 h-1.5 bg-amber-400 rounded-full mt-1.5 shrink-0"></span>
                  {w}
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-white rounded-[40px] p-10 border border-slate-100 shadow-sm">
            <h4 className="text-xl font-black mb-6 flex items-center gap-2 text-slate-800">
              <span>📉</span> 집중도 저하 구간
            </h4>
            <p className="text-sm font-bold text-slate-500 leading-relaxed bg-slate-50 p-6 rounded-2xl border border-dashed border-slate-200">
              {focus_drop.description}
            </p>
            {!focus_drop.has_drop_section && (
              <p className="mt-4 text-[10px] font-black text-blue-500 uppercase tracking-widest text-right">
                No Drop Sections Detected
              </p>
            )}
          </div>
        </div>

      </div>
    </div>
  );
};

export default ResultPage;