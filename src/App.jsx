import { BrowserRouter, Routes, Route } from "react-router-dom";
import LoginPage from "./LoginPage";
import TestPage from "./Testpage"; // 새로 만들 테스트 페이지
import ResultPage from "./ResultPage";
function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* 로그인 페이지 */}
        <Route path="/" element={<LoginPage />} />
        
        {/* MediaPipe 시선 추적이 작동하는 테스트 페이지 */}
        <Route path="/test" element={<TestPage />} />
        <Route path="/result" element={<ResultPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;