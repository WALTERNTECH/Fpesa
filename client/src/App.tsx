import { useApp } from './store/app';
import { Header } from './components/Header';
import { PriceChart } from './components/PriceChart';
import { TradePanel } from './components/TradePanel';
import { BottomNav } from './components/BottomNav';
import { MarketPicker } from './components/MarketPicker';
import { HistoryModal } from './components/HistoryModal';
import { SupportButton } from './components/SupportButton';
import { InstallPrompt } from './components/InstallPrompt';
import { AuthModal } from './components/AuthModal';
import { WalletModal } from './components/WalletModal';
import { FpesaAuto } from './components/FpesaAuto';
import { Toasts } from './components/Toasts';
import { Footer } from './components/Footer';

export function App(): JSX.Element {
  const { modal } = useApp();

  return (
    <>
      <Header />

      <main className="app">
        <MarketPicker />
        {/* One page, one flow: the market, the ticket, the two buttons.
            Everything else reaches the trader from the header menu or the
            bottom bar rather than stacking up under the trade. */}
        <PriceChart />
        <TradePanel />
      </main>

      <Footer />
      <BottomNav />
      <SupportButton />
      <InstallPrompt />
      <Toasts />

      {(modal === 'login' || modal === 'register') && <AuthModal mode={modal} />}
      {(modal === 'deposit' || modal === 'withdraw') && <WalletModal kind={modal} />}
      {modal === 'auto' && <FpesaAuto />}
      {modal === 'history' && <HistoryModal />}
    </>
  );
}
