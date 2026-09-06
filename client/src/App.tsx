import { useApp } from './store/app';
import { Header } from './components/Header';
import { NewsTicker } from './components/NewsTicker';
import { PriceChart } from './components/PriceChart';
import { TradePanel } from './components/TradePanel';
import { TradeBar } from './components/TradeBar';
import { SocialTabs } from './components/SocialTabs';
import { SupportButton } from './components/SupportButton';
import { InstallPrompt } from './components/InstallPrompt';
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

      <main className="app">
        <div className="desk">
          <PriceChart />
          <TradePanel />
        </div>
        <SocialTabs />
      </main>

      <Footer />
      <TradeBar />
      <SupportButton />
      <InstallPrompt />
      <Toasts />

      {(modal === 'login' || modal === 'register') && <AuthModal mode={modal} />}
      {(modal === 'deposit' || modal === 'withdraw') && <WalletModal kind={modal} />}
    </>
  );
}
