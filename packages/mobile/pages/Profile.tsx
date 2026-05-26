import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Award, Zap, Code, Settings, ExternalLink, LogOut, RefreshCw, AlertCircle, CheckCircle2, X } from 'lucide-react';
import { Card, Badge, Button } from '../components/Shared';
import { CURRENT_USER } from '../mockData';
import { useAuth } from '../contexts/AuthContext';
import { apiGet, apiPost } from '../api';

interface UserProfile {
  id: string;
  username: string | null;
  avatarUrl: string | null;
  email?: string | null;
  publicRepos?: number;
  techStack?: string[];
  totalEarned?: string;
  bountiesCompleted?: number;
}

export const Profile: React.FC = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  // Profile refresh / loading states
  const [profileData, setProfileData] = useState<UserProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);

  // Sync / Modal states
  const [showRefreshModal, setShowRefreshModal] = useState(false);
  const [patInput, setPatInput] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncSuccess, setSyncSuccess] = useState(false);

  useEffect(() => {
    let active = true;
    const fetchProfile = async () => {
      try {
        const data = await apiGet('/api/users/me');
        if (active) {
          setProfileData(data);
        }
      } catch (err) {
        console.error('Failed to load profile data:', err);
      } finally {
        if (active) {
          setLoadingProfile(false);
        }
      }
    };
    fetchProfile();
    return () => {
      active = false;
    };
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  const handleRefresh = async () => {
    if (!patInput.trim()) {
      setSyncError('Please enter a valid GitHub token');
      return;
    }
    setIsSyncing(true);
    setSyncError(null);
    try {
      const result = await apiPost('/api/profile/refresh-github', {
        githubAccessToken: patInput.trim(),
      });
      if (result.success) {
        setSyncSuccess(true);
        setProfileData(result.user);
        
        // Also update AuthContext user if avatarUrl or username changed
        const storedUser = localStorage.getItem('auth_user');
        if (storedUser) {
          const parsed = JSON.parse(storedUser);
          parsed.avatarUrl = result.user.avatarUrl || parsed.avatarUrl;
          parsed.username = result.user.username || parsed.username;
          localStorage.setItem('auth_user', JSON.stringify(parsed));
        }

        setTimeout(() => {
          setShowRefreshModal(false);
          setSyncSuccess(false);
          setPatInput('');
        }, 1500);
      } else {
        setSyncError(result.error || 'Failed to refresh GitHub profile');
      }
    } catch (err: unknown) {
      setSyncError(err instanceof Error ? err.message : 'An unexpected error occurred during synchronization');
    } finally {
      setIsSyncing(false);
    }
  };

  const techStack = profileData?.techStack || CURRENT_USER.techStack;
  const bountiesCompleted = profileData?.bountiesCompleted ?? CURRENT_USER.bountiesCompleted;
  const totalEarned = profileData?.totalEarned ? parseFloat(profileData.totalEarned) : CURRENT_USER.totalEarned;
  const successRate = CURRENT_USER.successRate; // fallback to mock for now since it is mock only

  return (
    <div className="min-h-full bg-background">
      {/* Sticky Header */}
      <div className="sticky top-0 z-30 flex justify-between items-center px-5 py-4 bg-background/95 backdrop-blur-xl border-b border-white/5">
        <h2 className="text-xl font-bold text-white">Profile</h2>
        <button
          onClick={() => navigate('/settings')}
          className="p-2.5 hover:bg-surface rounded-full text-text-secondary border border-transparent hover:border-white/10 transition-colors"
        >
          <Settings size={22} />
        </button>
      </div>

      {/* Content */}
      <div className="px-5 pb-24 space-y-6">
        {/* Profile Header */}
        <div className="flex flex-col items-center py-6">
          <div className="relative">
            <img src={profileData?.avatarUrl || user?.avatarUrl || CURRENT_USER.avatarUrl} alt="Profile" className="w-20 h-20 rounded-full border-4 border-surface shadow-2xl" />
            <div className="absolute bottom-0 right-0 bg-primary w-7 h-7 rounded-full border-4 border-background flex items-center justify-center">
              <Zap size={12} className="text-black fill-black" />
            </div>
          </div>
          <h3 className="mt-4 text-2xl font-bold">{profileData?.username || user?.username || CURRENT_USER.username}</h3>
          <a
            href={`https://github.com/${profileData?.username || user?.username || CURRENT_USER.username}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-primary mt-1 px-3 py-1 rounded-full bg-surface/50 border border-white/5"
          >
            github.com/{profileData?.username || user?.username || CURRENT_USER.username} <ExternalLink size={12} />
          </a>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-3 gap-3">
          <Card className="text-center py-3 px-2 bg-gradient-to-br from-surface to-surface/50">
            <div className="text-xl font-bold text-primary">
              {loadingProfile ? (
                <div className="h-7 w-12 bg-white/5 animate-pulse rounded mx-auto" />
              ) : (
                bountiesCompleted
              )}
            </div>
            <div className="text-[10px] uppercase text-text-secondary font-bold mt-1 tracking-wider">Bounties</div>
          </Card>
          <Card className="text-center py-3 px-2 bg-gradient-to-br from-surface to-surface/50">
            <div className="text-xl font-bold text-white">
              {loadingProfile ? (
                <div className="h-7 w-16 bg-white/5 animate-pulse rounded mx-auto" />
              ) : (
                `$${(totalEarned / 1000).toFixed(1)}k`
              )}
            </div>
            <div className="text-[10px] uppercase text-text-secondary font-bold mt-1 tracking-wider">Earned</div>
          </Card>
          <Card className="text-center py-3 px-2 bg-gradient-to-br from-surface to-surface/50">
            <div className="text-xl font-bold text-success">{successRate}%</div>
            <div className="text-[10px] uppercase text-text-secondary font-bold mt-1 tracking-wider">Success</div>
          </Card>
        </div>

        {/* Tech Stack */}
        <div className="space-y-3">
          <h4 className="text-sm font-bold text-text-secondary uppercase tracking-wider pl-1">Verified Tech Stack</h4>
          <div className="flex flex-wrap gap-2">
            {loadingProfile ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-8 w-24 bg-white/5 animate-pulse rounded-full" />
              ))
            ) : techStack && techStack.length > 0 ? (
              techStack.map((tech: string) => (
                <Badge key={tech} variant="outline" className="text-sm py-1.5 px-3 bg-surface border-border">
                  <Code size={14} className="mr-2 inline" /> {tech}
                </Badge>
              ))
            ) : (
              <span className="text-sm text-text-secondary pl-1">No technologies detected yet.</span>
            )}
          </div>
          <p className="text-xs text-text-secondary mt-2 px-1">
            Auto-detected from your GitHub repositories.
            <button
              onClick={() => setShowRefreshModal(true)}
              className="text-primary ml-1 hover:underline font-semibold transition-colors"
            >
              Refresh
            </button>
          </p>
        </div>

        {/* Recent Activity Mock */}
        <div className="space-y-3 pt-2">
          <h4 className="text-sm font-bold text-text-secondary uppercase tracking-wider pl-1">Achievements</h4>
          {/* SOC2 Style Badge */}
          <div className="inline-flex items-center bg-black border border-white/10 rounded-lg p-1.5 pr-4 gap-3 hover:border-yellow-500/50 transition-colors shadow-sm cursor-default group">
            <div className="w-9 h-9 bg-gradient-to-b from-yellow-400 to-yellow-600 rounded flex items-center justify-center text-black shadow-inner group-hover:scale-105 transition-transform">
              <Award size={18} strokeWidth={2.5} />
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] font-bold text-yellow-500 uppercase tracking-widest leading-none mb-0.5">Verified</span>
              <span className="text-xs font-bold text-white leading-tight">Early Adopter</span>
            </div>
          </div>
        </div>

        <div className="pt-8">
          <Button
            variant="outline"
            fullWidth
            className="text-error border-error/30 hover:bg-error/10 hover:border-error/50"
            onClick={() => setShowLogoutConfirm(true)}
          >
            Sign Out
          </Button>
        </div>
      </div>

      {/* GitHub Sync Modal */}
      {showRefreshModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={() => !isSyncing && setShowRefreshModal(false)}
          ></div>
          <div className="relative w-full max-w-md bg-[#111] border border-white/10 rounded-2xl p-6 shadow-2xl animate-in zoom-in-95 duration-200">
            <button
              onClick={() => setShowRefreshModal(false)}
              disabled={isSyncing}
              className="absolute top-4 right-4 text-text-secondary hover:text-white transition-colors"
            >
              <X size={18} />
            </button>
            <div className="flex flex-col space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary border border-primary/20">
                  <RefreshCw size={20} className={isSyncing ? "animate-spin" : ""} />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">Sync GitHub Data</h3>
                  <p className="text-xs text-text-secondary">Refresh your profile and tech stack</p>
                </div>
              </div>

              {syncSuccess ? (
                <div className="flex flex-col items-center justify-center py-6 text-center space-y-2">
                  <div className="w-12 h-12 rounded-full bg-success/15 flex items-center justify-center text-success border border-success/30 animate-bounce">
                    <CheckCircle2 size={24} />
                  </div>
                  <h4 className="text-base font-bold text-white">Sync Successful</h4>
                  <p className="text-xs text-text-secondary">Your tech stack and profile details have been updated!</p>
                </div>
              ) : (
                <>
                  <p className="text-xs text-text-secondary leading-relaxed bg-white/5 p-3 rounded-lg border border-white/5">
                    To trigger a full re-sync of your private/public repositories and technical stack, please supply a GitHub Personal Access Token. This token is used solely for the active session and is never stored.
                  </p>

                  <div className="space-y-1.5">
                    <label className="text-[10px] uppercase text-text-secondary font-bold tracking-wider pl-1">
                      GitHub Personal Access Token (PAT)
                    </label>
                    <input
                      type="password"
                      placeholder="ghp_..."
                      value={patInput}
                      onChange={(e) => setPatInput(e.target.value)}
                      disabled={isSyncing}
                      className="w-full bg-surface border border-white/10 rounded-xl p-3 text-sm text-white focus:border-primary focus:outline-none font-mono transition-colors"
                    />
                  </div>

                  {syncError && (
                    <div className="flex items-start gap-2 bg-error/10 border border-error/20 p-3 rounded-lg text-xs text-error">
                      <AlertCircle size={14} className="shrink-0 mt-0.5" />
                      <span>{syncError}</span>
                    </div>
                  )}

                  <div className="text-center">
                    <a
                      href="https://github.com/settings/tokens/new?scopes=read:user,repo&description=DevAsign%20Profile%20Refresh"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                    >
                      Generate a token on GitHub <ExternalLink size={10} />
                    </a>
                  </div>

                  <div className="flex gap-3 pt-2">
                    <Button
                      variant="ghost"
                      fullWidth
                      onClick={() => setShowRefreshModal(false)}
                      disabled={isSyncing}
                      className="bg-white/5 hover:bg-white/10 text-white"
                    >
                      Cancel
                    </Button>
                    <Button
                      fullWidth
                      onClick={handleRefresh}
                      disabled={isSyncing}
                      className="bg-primary hover:bg-primary/90 text-background shadow-lg shadow-primary/20"
                    >
                      {isSyncing ? (
                        <span className="flex items-center gap-1">
                          <RefreshCw size={14} className="animate-spin" /> Syncing...
                        </span>
                      ) : (
                        "Sync Stack"
                      )}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Logout Confirmation Modal */}
      {showLogoutConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={() => setShowLogoutConfirm(false)}
          ></div>
          <div className="relative w-full max-w-sm bg-[#111] border border-white/10 rounded-2xl p-6 shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex flex-col items-center text-center space-y-4">
              <div className="w-12 h-12 rounded-full bg-error/10 flex items-center justify-center text-error border border-error/20">
                <LogOut size={24} />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">Sign Out</h3>
                <p className="text-sm text-text-secondary mt-1 px-4">
                  Are you sure you want to sign out of your account?
                </p>
              </div>
              <div className="flex gap-3 w-full pt-2">
                <Button
                  variant="ghost"
                  fullWidth
                  onClick={() => setShowLogoutConfirm(false)}
                  className="bg-white/5 hover:bg-white/10 text-white"
                >
                  Cancel
                </Button>
                <Button
                  fullWidth
                  onClick={handleLogout}
                  className="bg-error hover:bg-error/90 text-white shadow-lg shadow-error/20"
                >
                  Sign Out
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};