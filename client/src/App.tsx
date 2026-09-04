import { useApp } from './store/app';
import { Header } from './components/Header';
import { NewsTicker } from './components/NewsTicker';
import { Hero } from './components/Hero';
import { PriceChart } from './components/PriceChart';
import { TradePanel } from './components/TradePanel';
import { ChatRoom } from './components/ChatRoom';
import { ActivityFeed } from './components/ActivityFeed';
import { Leaderboard } from './components/Leaderboard';
import { SupportButton } from './components/SupportButton';
import { AuthModal } from './components/AuthModal';
import { WalletModal } from './components/WalletModal';
import { Toasts } from './components/Toasts';
import { Footer } from './components/Footer';

export function App(): JSX.Element {
  const { modal } = useApp();

  return (
    <>
      <Header />
      <NewsTicker />

      <main>
        <Hero />

        <section className="section" id="desk">
          <div className="container">
            <div className="section-head">
              <h2 style={{ fontSize: 20 }}>Trading desk</h2>
              <span className="eyebrow">Live market · XAU/USD</span>
            </div>
            <div className="desk-grid">
              <PriceChart />
              <TradePanel />
            </div>
          </div>
        </section>

        <section className="section" id="community">
          <div className="container">
            <div className="section-head">
              <h2 style={{ fontSize: 20 }}>The floor</h2>
              <span className="eyebrow">Chat · Activity · Leaders</span>
            </div>
            <div className="social-grid">
              <ChatRoom />
              <ActivityFeed />
              <Leaderboard />
            </div>
          </div>
        </section>
      </main>

      <Footer />
      <SupportButton />
      <Toasts />

      {(modal === 'login' || modal === 'register') && <AuthModal mode={modal} />}
      {(modal === 'deposit' || modal === 'withdraw') && <WalletModal kind={modal} />}
    </>
  );
}
