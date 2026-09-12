import { useApp } from './store/app';
import { Header } from './components/Header';
import { NewsTicker } from './components/NewsTicker';
import { PriceChart } from './components/PriceChart';
import { DigitTicker } from './components/DigitTicker';
import { TradePanel } from './components/TradePanel';
import { TradeBar } from './components/TradeBar';
import { MarketPicker } from './components/MarketPicker';
import { TradeHistory } from './components/TradeHistory';
import { AutoRunSpinner } from './components/AutoRunSpinner';
import { SupportButton } from './components/SupportButton';
import { InstallPrompt } from './components/InstallPrompt';
import { AuthModal } from './components/AuthModal';
import { WalletModal } from './components/WalletModal';
import { PassModal } from './components/PassModal';
import { Toasts } from './components/Toasts';
import { Footer } from './components/Footer';

export function App(): JSX.Element {
  const { modal } = useApp();

  return (
    <>
      <Header />
      <NewsTicker />

      <main className="app">
        <MarketPicker />
        <div className="desk">
          {/* The chart, then the digits it resolves to — the digit strip sits
              directly under the price because it is what the ticket reads. */}
          <div className="chart-col">
            <PriceChart />
            <DigitTicker />
          </div>
          <TradePanel />
        </div>
        <TradeHistory />
      </main>

      <Footer />
      <TradeBar />
      <AutoRunSpinner />
      <SupportButton />
      <InstallPrompt />
      <Toasts />

      {(modal === 'login' || modal === 'register') && <AuthModal mode={modal} />}
      {(modal === 'deposit' || modal === 'withdraw') && <WalletModal kind={modal} />}
      {modal === 'pass' && <PassModal />}
    </>
  );
}
