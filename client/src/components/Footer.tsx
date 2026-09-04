import { useApp } from '../store/app';
import { Brand } from './Header';

export function Footer(): JSX.Element {
  const { config, openModal, user } = useApp();
  const year = new Date().getFullYear();

  return (
    <footer className="footer">
      <div className="container">
        <div className="risk-note">
          <strong>Risk warning.</strong> Short-duration trading carries a high risk of losing
          your money. Prices can move against you within seconds, and you can lose the full
          amount you stake on a trade. Only trade with money you can afford to lose, and
          practise on the demo account first. Fpesa does not provide investment advice.
        </div>

        <div className="footer-grid">
          <div className="footer-brand">
            <Brand />
            <p>
              Live gold and forex trading built for Kenya, with M-Pesa deposits and
              withdrawals on the number you sign up with.
            </p>
          </div>

          <div className="footer-links">
            <div className="footer-col">
              <h4>Trading</h4>
              <ul>
                <li>
                  <a href="#desk">Live XAU/USD chart</a>
                </li>
                <li>
                  <a href="#desk">Trading desk</a>
                </li>
                <li>
                  <a href="#community">Leaderboard</a>
                </li>
              </ul>
            </div>

            <div className="footer-col">
              <h4>Account</h4>
              <ul>
                {user ? (
                  <>
                    <li>
                      <button onClick={() => openModal('deposit')}>Deposit</button>
                    </li>
                    <li>
                      <button onClick={() => openModal('withdraw')}>Withdraw</button>
                    </li>
                  </>
                ) : (
                  <>
                    <li>
                      <button onClick={() => openModal('register')}>Create account</button>
                    </li>
                    <li>
                      <button onClick={() => openModal('login')}>Log in</button>
                    </li>
                  </>
                )}
              </ul>
            </div>

            <div className="footer-col">
              <h4>Support</h4>
              <ul>
                <li>
                  <a href={config.supportTelegram} target="_blank" rel="noopener noreferrer">
                    Telegram support
                  </a>
                </li>
                <li>
                  <a href="#community">Trader chat</a>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="footer-bottom">
          © {year} Fpesa. All rights reserved. Trading involves risk to your capital.
        </div>
      </div>
    </footer>
  );
}
