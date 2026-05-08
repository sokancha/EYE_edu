import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { signIn, signUp, confirmSignUp, signOut } from 'aws-amplify/auth';

const LoginPage = () => {
  const [isSignup, setIsSignup] = useState(false);
  const [isConfirm, setIsConfirm] = useState(false);
  const [formData, setFormData] = useState({ id: '', pw: '', name: '', code: '' });
  const navigate = useNavigate();

  // 페이지 진입 시 혹시 남아있을지 모를 세션 초기화
  useEffect(() => {
    const initSession = async () => {
      try {
        await signOut();
      } catch (e) {
        // 이미 로그아웃 상태면 무시
      }
    };
    initSession();
  }, []);

  const handleInputChange = (e) => {
    const { id, value } = e.target;
    setFormData((prev) => ({ ...prev, [id]: value }));
  };

  // 1. 로그인 로직
  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      const username = formData.id.trim();
      const password = formData.pw;

      const { isSignedIn } = await signIn({
        username: username,
        password: password,
      });

      if (isSignedIn) {
        localStorage.setItem('user_id', username);
        alert(`환영합니다, ${username}님!`);
        navigate('/test'); 
      }
    } catch (error) {
      console.error("로그인 에러:", error.name, error.message);

      if (error.name === 'UserNotConfirmedException') {
        alert('이메일 인증이 완료되지 않았습니다. 인증 코드를 입력해주세요.');
        setIsConfirm(true);
      } else if (error.name === 'NotAuthorizedException') {
        alert('아이디 또는 비밀번호가 틀립니다. 대소문자를 확인해 주세요.');
      } else if (error.name === 'UserNotFoundException') {
        alert('가입되지 않은 계정입니다.');
      } else if (error.name === 'UserAlreadyAuthenticatedException') {
        // 이미 인증된 경우 세션 초기화 후 재시도 안내
        await signOut();
        alert('기존 세션을 정리했습니다. 다시 로그인 버튼을 눌러주세요.');
      } else {
        alert('로그인 실패: ' + error.message);
      }
    }
  };

  // 2. 회원가입 로직
  const handleSignup = async (e) => {
    e.preventDefault();
    try {
      await signUp({
        username: formData.id.trim(),
        password: formData.pw,
        options: { 
          userAttributes: { 
            name: formData.name 
          } 
        },
      });
      alert('인증 코드가 이메일로 전송되었습니다.');
      setIsConfirm(true); 
    } catch (error) {
      console.error("회원가입 에러:", error);
      alert('회원가입 실패: ' + error.message);
    }
  };

  // 3. 이메일 인증 확인 로직 (중요: 인증 후 signOut 추가)
  const handleConfirmCode = async (e) => {
    e.preventDefault();
    try {
      await confirmSignUp({
        username: formData.id.trim(),
        confirmationCode: formData.code.trim(),
      });

      // 가입 과정에서 생긴 임시 세션 제거하여 정석 로그인 유도
      await signOut();

      alert('인증 성공! 이제 로그인 페이지에서 접속해주세요.');
      setIsConfirm(false);
      setIsSignup(false);
      // 비밀번호와 코드는 초기화하여 다시 입력받도록 함
      setFormData({ ...formData, pw: '', code: '' });

    } catch (error) {
      console.error("인증 에러:", error);
      alert('인증 실패: 코드를 다시 확인해주세요.');
    }
  };

  return (
    <div className="min-h-screen flex font-sans bg-white text-slate-900">
      {/* 좌측 디자인 섹션 */}
      <div className="hidden lg:flex lg:w-1/2 bg-blue-600 p-12 flex-col justify-between text-white">
        <div><h1 className="text-3xl font-black tracking-tighter text-white">DAI-Ly</h1></div>
        <div>
          <h2 className="text-5xl font-bold leading-tight mb-6">시선 추적으로 분석하는<br />나의 진짜 학습 집중도</h2>
          <p className="text-blue-100 text-xl leading-relaxed">인공지능 알고리즘과 클라우드 인프라를 통해<br />정밀한 집중도 분석 리포트를 제공합니다.</p>
        </div>
        <div className="flex gap-6 text-sm text-blue-200 font-mono"><span>AWS Cognito</span><span>DynamoDB Ready</span></div>
      </div>

      {/* 우측 폼 섹션 */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-8 bg-slate-50">
        <div className="max-w-md w-full">
          <div className="bg-white p-10 rounded-3xl shadow-xl shadow-slate-200 border border-slate-100">
            
            {isConfirm ? (
              <div id="confirmSection">
                <h3 className="text-2xl font-bold mb-2">이메일 인증</h3>
                <p className="text-slate-500 mb-8 font-medium">{formData.id}로 전송된 코드를 입력하세요.</p>
                <form onSubmit={handleConfirmCode} className="space-y-4">
                  <div>
                    <label className="block text-sm font-bold text-slate-700 mb-2 ml-1">인증 코드</label>
                    <input type="text" id="code" value={formData.code} onChange={handleInputChange} className="w-full px-5 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-blue-100 outline-none transition-all" placeholder="6자리 코드 입력" required />
                  </div>
                  <button type="submit" className="w-full py-5 mt-4 bg-green-600 hover:bg-green-700 text-white rounded-2xl shadow-lg text-xl font-bold transition-all active:scale-95">인증 완료</button>
                </form>
              </div>
            ) : !isSignup ? (
              <div id="loginSection">
                <h3 className="text-2xl font-bold mb-2">로그인</h3>
                <p className="text-slate-500 mb-8 font-medium">학습을 시작하려면 정보를 입력해주세요.</p>
                <form onSubmit={handleLogin} className="space-y-4">
                  <div>
                    <label className="block text-sm font-bold text-slate-700 mb-2 ml-1">이메일</label>
                    <input type="text" id="id" value={formData.id} onChange={handleInputChange} className="w-full px-5 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-blue-100 outline-none transition-all" placeholder="example@email.com" required />
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-slate-700 mb-2 ml-1">비밀번호</label>
                    <input type="password" id="pw" value={formData.pw} onChange={handleInputChange} className="w-full px-5 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-blue-100 outline-none transition-all" placeholder="비밀번호 입력" required />
                  </div>
                  <button type="submit" className="w-full py-5 mt-4 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl shadow-lg text-xl font-bold transition-all active:scale-95">학습 시작하기</button>
                </form>
                <p className="mt-8 text-center text-sm text-slate-400">계정이 없으신가요? <button onClick={() => setIsSignup(true)} className="text-blue-600 font-bold hover:underline">회원가입</button></p>
              </div>
            ) : (
              <div id="signupSection">
                <h3 className="text-2xl font-bold mb-2">회원가입</h3>
                <p className="text-slate-500 mb-8 font-medium">DAI-Ly의 새로운 회원이 되어보세요.</p>
                <form onSubmit={handleSignup} className="space-y-4">
                  <div><label className="block text-sm font-bold text-slate-700 mb-2 ml-1">이름</label><input type="text" id="name" value={formData.name} onChange={handleInputChange} className="w-full px-5 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-blue-100 outline-none transition-all" placeholder="성함 입력" required /></div>
                  <div><label className="block text-sm font-bold text-slate-700 mb-2 ml-1">이메일</label><input type="text" id="id" value={formData.id} onChange={handleInputChange} className="w-full px-5 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-blue-100 outline-none transition-all" placeholder="example@email.com" required /></div>
                  <div><label className="block text-sm font-bold text-slate-700 mb-2 ml-1">비밀번호</label><input type="password" id="pw" value={formData.pw} onChange={handleInputChange} className="w-full px-5 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-blue-100 outline-none transition-all" placeholder="대문자 포함 8자 이상" required /></div>
                  <button type="submit" className="w-full py-5 mt-4 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl shadow-lg text-xl font-bold transition-all active:scale-95">가입하기</button>
                </form>
                <p className="mt-8 text-center text-sm text-slate-400">이미 계정이 있으신가요? <button onClick={() => setIsSignup(false)} className="text-blue-600 font-bold hover:underline">로그인</button></p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;