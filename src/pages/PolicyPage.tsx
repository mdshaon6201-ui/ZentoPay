import React, { useState } from 'react';
import { ArrowLeft, Check, ChevronDown, Send, ShieldCheck } from 'lucide-react';
import { useRouter } from '../context/RouterContext.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { ZentoPayEmblem } from '../components/ewallet/MethodLogo.tsx';
import { formatCommissionPercent, formatCommissionPercentBn } from '../lib/commissions.ts';

export function PolicyPage() {
  const { navigate } = useRouter();
  const { platformConfig } = useAuth();
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  const telegramSupport = platformConfig.supportLinks.telegram || '';
  const rates = platformConfig.commissionRates;
  const bkashBn = formatCommissionPercentBn(rates.bkash);
  const nagadBn = formatCommissionPercentBn(rates.nagad);
  const rocketBn = formatCommissionPercentBn(rates.rocket);
  const bkashEn = formatCommissionPercent(rates.bkash);
  const nagadEn = formatCommissionPercent(rates.nagad);
  const rocketEn = formatCommissionPercent(rates.rocket);

  const faqs = [
    {
      q: '১. কীভাবে একজন ভেরিফাইড ZentoPay এজেন্ট হবো?',
      a: 'ZentoPay-এ রেজিস্ট্রেশন করে আপনার সঠিক ব্যক্তিগত তথ্য ও NID দিয়ে KYC ভেরিফিকেশন সম্পন্ন করুন এবং Trial Plan বা Premium Plan-এর মাধ্যমে এজেন্টশিপ সক্রিয় করুন।',
    },
    {
      q: '২. কাজ শুরু করতে কী কী প্রয়োজন?',
      a: 'বিকাশ, নগদ বা রকেট-এর Personal, Merchant অথবা Agent অ্যাকাউন্ট, সঠিক ব্যক্তিগত তথ্য, KYC ভেরিফিকেশন এবং যেকোনো একটি এজেন্ট প্ল্যান।',
    },
    {
      q: '৩. কোন কোন ওয়ালেট ব্যবহার করা যাবে?',
      a: 'আপনি বিকাশ (bKash), নগদ (Nagad) এবং রকেট (Rocket) ওয়ালেট নম্বর গেটওয়েতে যুক্ত করে ব্যবহার করতে পারবেন।',
    },
    {
      q: '৪. Agent Plan-এর ডিপোজিট কত টাকা?',
      a: 'নতুনদের জন্য Trial Plan ৳৫,০০০ (৩০ দিনের ট্রায়াল) এবং অভিজ্ঞ এজেন্টদের জন্য Premium Plan ৳১৫,০০০ (লাইফটাইম)। এই পরিমাণ সরাসরি আপনার ওয়ালেট ব্যালেন্সে জমা থাকে।',
    },
    {
      q: '৫. MFS লেনদেনে Commission কত?',
      a: `প্রতিটি সফল পেমেন্ট কালেকশন ও পেআউট লেনদেনে প্রোভাইডার অনুযায়ী কমিশন প্রদান করা হয়: bKash-এ ${bkashBn} (${bkashEn}), Nagad-এ ${nagadBn} (${nagadEn}) এবং Rocket-এ ${rocketBn} (${rocketEn})। এছাড়া যোগ্য অ্যাফিলিয়েট এজেন্টরা ১% রেফারেল কমিশন পান।`,
    },
    {
      q: '৬. নিজে কি Customer খুঁজতে হবে?',
      a: 'না, আপনাকে নিজে থেকে কোনো কাস্টমার খুঁজতে হবে না। ভেরিফাইড এজেন্ট অ্যাকাউন্ট ও গেটওয়ে সক্রিয় থাকলে সিস্টেম থেকে স্বয়ংক্রিয়ভাবে পেমেন্ট রিকোয়েস্ট আপনার ড্যাশবোর্ডে আসবে।',
    },
    {
      q: '৭. Withdrawal কীভাবে করবো?',
      a: 'ড্যাশবোর্ডের Withdraw সেকশন থেকে বিকাশ, নগদ, রকেট বা ব্যাংক ট্রান্সফারের মাধ্যমে ন্যূনতম ৳৫০০ থেকে উত্তোলনের রিকোয়েস্ট করতে পারবেন (উইথড্র পিন আবশ্যক)।',
    },
    {
      q: '৮. Refund পাওয়া যাবে কি?',
      a: 'হ্যাঁ, কাজ চালিয়ে যেতে না চাইলে আপনার ম্যানেজারের সাথে যোগাযোগ করে রিফান্ড রিকোয়েস্ট করতে পারবেন। যাচাই শেষে সাধারণত ১–২৪ ঘণ্টার মধ্যে প্রসেস সম্পন্ন হয়।',
    },
    {
      q: '৯. Support কোথায় পাবো?',
      a: 'যেকোনো প্রয়োজনে অ্যাপের Help & Support সেকশন থেকে অফিশিয়াল টেলিগ্রাম বা হোয়াটসঅ্যাপ সাপোর্টে যোগাযোগ করতে পারেন।',
    },
  ];

  return (
    <div className="min-h-screen bg-[#F4F7F5] text-[#12251D] pb-24 md:pb-12">
      {/* Top Navbar */}
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-[#E2EBE6]">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="inline-flex items-center gap-2.5 cursor-pointer"
          >
            <ZentoPayEmblem size={34} />
            <div className="text-left">
              <span className="font-extrabold text-base text-[#075B3A] block leading-none">ZentoPay</span>
              <span className="text-[11px] font-semibold text-[#6B7C73]">এজেন্ট নীতিমালা ও নির্দেশিকা</span>
            </div>
          </button>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[#E2EBE6] bg-white hover:bg-[#E9F7F0] text-xs font-bold text-[#075B3A] cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to App
            </button>
            <button
              type="button"
              onClick={() => navigate('/register')}
              className="hidden sm:inline-flex items-center px-4 py-2 rounded-xl bg-[#075B3A] hover:bg-[#0B7A4A] text-white text-xs font-bold cursor-pointer"
            >
              Agent Registration
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* Hero */}
        <section className="bg-gradient-to-br from-[#075B3A] to-[#043824] rounded-3xl p-7 sm:p-10 text-white shadow-lg">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/15 text-xs font-bold text-[#E9F7F0] mb-4">
            <ShieldCheck className="w-4 h-4" />
            ভেরিফাইড এজেন্ট গাইডলাইন
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold leading-snug max-w-2xl">
            কীভাবে একজন ভেরিফাইড ZentoPay Agent হয়ে কমিশনের মাধ্যমে আয় করবেন
          </h1>
          <p className="mt-3 text-sm text-white/85 max-w-2xl leading-relaxed">
            ZentoPay-এর মাধ্যমে আপনার bKash, Nagad ও Rocket ওয়ালেট নিরাপদভাবে যুক্ত করে পেমেন্ট কালেকশন ও পেমেন্ট পেআউট রিকোয়েস্ট পরিচালনার মাধ্যমে আকর্ষণীয় কমিশন অর্জন করুন।
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-7">
            <div className="bg-white/10 border border-white/15 rounded-2xl p-3.5">
              <div className="text-xl font-extrabold">500+ Agent</div>
              <div className="text-[11px] text-white/75 mt-0.5">সক্রিয় এজেন্ট নেটওয়ার্ক</div>
            </div>
            <div className="bg-white/10 border border-white/15 rounded-2xl p-3.5">
              <div className="text-xl font-extrabold">70+ Partners</div>
              <div className="text-[11px] text-white/75 mt-0.5">সমন্বিত প্ল্যাটফর্ম</div>
            </div>
            <div className="bg-white/10 border border-white/15 rounded-2xl p-3.5">
              <div className="text-xl font-extrabold text-[#52E5A5]">bKash {bkashEn}</div>
              <div className="text-[11px] text-white/75 mt-0.5">অনুমোদিত bKash কমিশন</div>
            </div>
            <div className="bg-white/10 border border-white/15 rounded-2xl p-3.5">
              <div className="text-xl font-extrabold text-[#52E5A5]">
                {nagadEn} / {rocketEn}
              </div>
              <div className="text-[11px] text-white/75 mt-0.5">Nagad ও Rocket কমিশন</div>
            </div>
          </div>
        </section>

        {/* What is ZentoPay & How it works */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="bg-white rounded-3xl p-6 border border-[#E2EBE6] shadow-xs space-y-3">
            <h2 className="text-lg font-extrabold text-[#12251D]">ZentoPay কী?</h2>
            <p className="text-sm text-[#6B7C73] leading-relaxed">
              ZentoPay হলো একটি আধুনিক MFS এজেন্ট ওয়ালেট ও গেটওয়ে ব্যবস্থাপনা প্ল্যাটফর্ম, যেখানে যাচাইকৃত এজেন্টরা গ্রাহকদের পেমেন্ট কালেকশন ও পেআউট লেনদেন সম্পন্ন করে নির্ধারিত হারে কমিশন উপার্জন করেন।
            </p>
          </div>
          <div className="bg-white rounded-3xl p-6 border border-[#E2EBE6] shadow-xs space-y-3">
            <h2 className="text-lg font-extrabold text-[#12251D]">ZentoPay কীভাবে কাজ করে?</h2>
            <p className="text-sm text-[#6B7C73] leading-relaxed">
              আপনার ড্যাশবোর্ডে কমপক্ষে ৳১,০০০ ব্যালেন্স রেখে আপনার bKash, Nagad বা Rocket নম্বর গেটওয়েতে সক্রিয় করতে হয়। এরপর সিস্টেম থেকে প্রাপ্ত পেমেন্ট কালেকশন ও পেআউট রিকোয়েস্ট যাচাই করে অনুমোদন করলেই ব্যালেন্স ও কমিশন স্বয়ংক্রিয়ভাবে আপডেট হয়।
            </p>
          </div>
        </section>

        {/* Agent Responsibilities */}
        <section className="bg-white rounded-3xl p-6 sm:p-8 border border-[#E2EBE6] shadow-xs space-y-4">
          <h2 className="text-xl font-extrabold text-[#12251D]">Agent হিসেবে আপনার কাজ কী?</h2>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              'গেটওয়েতে সক্রিয় MFS নম্বর সঠিকভাবে যুক্ত রাখা।',
              'প্রাপ্ত পেমেন্ট কালেকশন রিকোয়েস্টে TrxID যাচাই করে অনুমোদন করা।',
              'পর্যাপ্ত ব্যালেন্স রেখে পেমেন্ট পেআউট রিকোয়েস্ট দ্রুত সম্পন্ন করা।',
              'নির্ধারিত নিয়ম অনুযায়ী স্বচ্ছভাবে Transaction পরিচালনা করা।',
              'Dashboard থেকে Transaction ও Commission হিসাব পর্যবেক্ষণ করা।',
              'যোগ্য Transaction-এর বিপরীতে প্রযোজ্য Commission গ্রহণ করা।',
            ].map((item, idx) => (
              <li
                key={idx}
                className="flex items-start gap-3 bg-[#F4F7F5] p-3.5 rounded-xl border border-[#E2EBE6]"
              >
                <span className="w-5 h-5 rounded-full bg-[#E9F7F0] text-[#075B3A] flex items-center justify-center shrink-0 mt-0.5">
                  <Check className="w-3.5 h-3.5" />
                </span>
                <span className="text-sm text-[#12251D] font-medium">{item}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Requirements */}
        <section className="bg-white rounded-3xl p-6 sm:p-8 border border-[#E2EBE6] shadow-xs space-y-5">
          <h2 className="text-xl font-extrabold text-[#12251D]">Agent হতে কী কী প্রয়োজন?</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            {[
              'বিকাশ, নগদ বা রকেট-এর Personal, Merchant অথবা Agent Account।',
              'সঠিক ব্যক্তিগত তথ্য ও সক্রিয় ইমেইল ঠিকানা।',
              'প্রয়োজনীয় KYC Verification (NID যাচাই) সম্পন্ন করা।',
              'ZentoPay-এর নির্ধারিত Trial Plan অথবা Premium Plan গ্রহণ করা।',
              'ZentoPay-এর নিয়ম, নিরাপত্তা নীতি ও শর্তাবলী মেনে চলা।',
            ].map((text, idx) => (
              <div
                key={idx}
                className={`bg-[#F4F7F5] border border-[#E2EBE6] p-4 rounded-2xl flex items-start gap-3 ${
                  idx === 4 ? 'sm:col-span-2' : ''
                }`}
              >
                <span className="w-6 h-6 rounded-full bg-[#E9F7F0] text-[#075B3A] font-bold text-xs flex items-center justify-center shrink-0">
                  {idx + 1}
                </span>
                <p className="text-sm text-[#12251D] font-medium">{text}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Agent Plans */}
        <section className="space-y-5">
          <div className="text-center space-y-1.5">
            <h2 className="text-xl sm:text-2xl font-extrabold text-[#12251D]">
              কাজের সুবিধার্থে সহজ দুইটি এজেন্টশিপ প্ল্যান
            </h2>
            <p className="text-xs sm:text-sm text-[#6B7C73]">
              নতুনদের জন্য Trial Plan এবং অভিজ্ঞ এজেন্টদের জন্য Premium Plan
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="bg-white rounded-3xl p-6 sm:p-7 border border-[#E2EBE6] shadow-xs flex flex-col justify-between space-y-5">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xl font-extrabold text-[#12251D]">Trial Plan</h3>
                  <span className="px-3 py-1 rounded-full bg-[#E9F7F0] text-[#075B3A] text-xs font-bold">
                    নতুনদের জন্য
                  </span>
                </div>
                <div className="text-3xl font-black text-[#075B3A] mb-4">৳৫,০০০</div>
                <ul className="space-y-2.5 text-sm text-[#6B7C73]">
                  <li>• ৩০ দিনের ট্রায়াল এজেন্ট অ্যাকাউন্ট</li>
                  <li>• ছোট পরিমাণের পেমেন্ট কালেকশন ও পেআউট রিকোয়েস্ট</li>
                  <li>• Personal ও Agent নম্বর গেটওয়ে সাপোর্ট</li>
                  <li>• দৈনিক ৬ ঘণ্টার ট্রাফিক শিডিউল</li>
                  <li>• ২৪/৭ এজেন্ট সাপোর্ট সুবিধা</li>
                </ul>
              </div>
              <button
                type="button"
                onClick={() => navigate('/register')}
                className="w-full py-3 rounded-xl bg-[#E9F7F0] hover:bg-[#d8efe2] text-[#075B3A] font-bold text-sm cursor-pointer"
              >
                Trial Plan দিয়ে শুরু করুন
              </button>
            </div>

            <div className="bg-white rounded-3xl p-6 sm:p-7 border-2 border-[#075B3A] shadow-md flex flex-col justify-between space-y-5">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xl font-extrabold text-[#075B3A]">Premium Plan</h3>
                  <span className="px-3 py-1 rounded-full bg-[#075B3A] text-white text-xs font-bold">
                    অভিজ্ঞ এজেন্ট
                  </span>
                </div>
                <div className="text-3xl font-black text-[#075B3A] mb-4">৳১৫,০০০</div>
                <ul className="space-y-2.5 text-sm text-[#6B7C73]">
                  <li>• লাইফটাইম ভেরিফাইড এজেন্ট মেম্বারশিপ</li>
                  <li>• আনলিমিটেড ট্রাফিক ও হাই-ভলিউম রিকোয়েস্ট</li>
                  <li>• Personal, Agent ও Merchant গেটওয়ে সাপোর্ট</li>
                  <li>• অ্যাফিলিয়েট প্রোগ্রাম যোগ্যতা (৩০ দিন পর ১%+১% কমিশন)</li>
                  <li>• অগ্রাধিকারমূলক সাপোর্ট ও দ্রুত উইথড্রয়াল</li>
                </ul>
              </div>
              <button
                type="button"
                onClick={() => navigate('/register')}
                className="w-full py-3 rounded-xl bg-[#075B3A] hover:bg-[#0B7A4A] text-white font-bold text-sm cursor-pointer"
              >
                Premium Plan বেছে নিন
              </button>
            </div>
          </div>
        </section>

        {/* Commission, Withdrawal, Refund & Account Rules */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="bg-white rounded-3xl p-6 border border-[#E2EBE6] shadow-xs space-y-2.5">
            <h3 className="text-base font-extrabold text-[#075B3A]">কমিশন ও ব্যালেন্স উত্তোলন নিয়ম</h3>
            <p className="text-xs sm:text-sm text-[#6B7C73] leading-relaxed">
              প্রতিটি অনুমোদিত MFS লেনদেনে bKash-এ {bkashBn}, Nagad-এ {nagadBn} এবং Rocket-এ {rocketBn} কমিশন তাৎক্ষণিকভাবে আপনার ওয়ালেট ব্যালেন্সে যোগ হয়। বিকাশ, নগদ, রকেট বা ব্যাংক অ্যাকাউন্টের মাধ্যমে ন্যূনতম ৳৫০০ থেকে উইথড্র করা যায় (উইথড্র পিন বাধ্যতামূলক)।
            </p>
          </div>
          <div className="bg-white rounded-3xl p-6 border border-[#E2EBE6] shadow-xs space-y-2.5">
            <h3 className="text-base font-extrabold text-[#075B3A]">নিরাপত্তা, KYC ও রিফান্ড নীতি</h3>
            <p className="text-xs sm:text-sm text-[#6B7C73] leading-relaxed">
              ভুয়া TrxID প্রদান, অনুমোদন ছাড়াই রিকোয়েস্ট আটকে রাখা বা ভুয়া KYC ডকুমেন্ট আপলোড করা কঠোরভাবে নিষিদ্ধ। সৎ এজেন্টদের জন্য ২৪ ঘণ্টার মধ্যে রিফান্ড আবেদন প্রক্রিয়াকরণের সুবিধা রয়েছে।
            </p>
          </div>
        </section>

        {/* FAQ Accordion */}
        <section className="bg-white rounded-3xl p-6 sm:p-8 border border-[#E2EBE6] shadow-xs space-y-4">
          <h2 className="text-xl font-extrabold text-[#12251D]">সচরাচর জিজ্ঞাসিত প্রশ্নাবলী (FAQ)</h2>
          <div className="space-y-2.5">
            {faqs.map((item, idx) => {
              const isOpen = openFaq === idx;
              return (
                <div key={idx} className="border border-[#E2EBE6] rounded-2xl overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setOpenFaq(isOpen ? null : idx)}
                    className="w-full px-5 py-4 text-left font-bold text-[#12251D] text-sm flex items-center justify-between bg-[#F4F7F5]/70 hover:bg-[#E9F7F0]/60 cursor-pointer"
                  >
                    <span>{item.q}</span>
                    <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {isOpen && (
                    <div className="px-5 py-4 text-xs sm:text-sm text-[#6B7C73] border-t border-[#E2EBE6] leading-relaxed bg-white">
                      {item.a}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Final CTA */}
        <section className="bg-gradient-to-tr from-[#075B3A] to-[#16A66A] rounded-3xl p-7 sm:p-10 text-center text-white space-y-5 shadow-lg">
          <h2 className="text-2xl sm:text-3xl font-extrabold">আজই Verified ZentoPay Agent হিসেবে শুরু করুন</h2>
          <p className="text-sm text-white/90 max-w-xl mx-auto">
            আপনার বিকাশ, নগদ ও রকেট ওয়ালেট ব্যবহার করে নিরাপদভাবে কমিশন আয় শুরু করুন।
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 max-w-md mx-auto">
            <button
              type="button"
              onClick={() => navigate('/register')}
              className="w-full sm:w-1/2 py-3.5 px-5 rounded-xl bg-white text-[#075B3A] font-extrabold text-sm shadow-md cursor-pointer"
            >
              এখনই রেজিস্ট্রেশন করুন
            </button>
            {telegramSupport ? (
              <a
                href={telegramSupport}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full sm:w-1/2 py-3.5 px-5 rounded-xl bg-[#0088cc] text-white font-extrabold text-sm shadow-md inline-flex items-center justify-center gap-2"
              >
                <Send className="w-4 h-4" />
                ম্যানেজার সাপোর্ট
              </a>
            ) : (
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="w-full sm:w-1/2 py-3.5 px-5 rounded-xl bg-white/15 border border-white/30 text-white font-extrabold text-sm cursor-pointer"
              >
                লগইন পোর্টাল
              </button>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
